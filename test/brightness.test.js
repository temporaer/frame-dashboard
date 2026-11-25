import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { parseBrightness, brightnessConnection } from '../lib/brightness-config.js';
import { loadConfig } from '../lib/config.js';
import { ForegroundLease, evaluateBrightness, curveValue } from '../lib/brightness.js';
import { BrightnessObserver } from '../lib/brightness-observer.js';
import { readBrightness } from '../lib/adapters/brightness-ha.js';
import { Authentication } from '../lib/authentication.js';
import { Runtime } from '../lib/runtime.js';
import { createDashboard } from '../lib/server.js';

const wall = Date.parse('2026-11-25T18:00:00Z');
const reported = new Date(wall).toISOString();
const settings = (extra = {}) => parseBrightness({
  enabled: true, luxEntity: 'sensor.room_lux', backlightEntity: 'number.screen_backlight',
  tvEntity: 'media_player.screen', luxMaxAgeSeconds: 120, backlightMaxAgeSeconds: 120, tvMaxAgeSeconds: 120,
  min: 10, max: 20, curve: [{ lux: 0, value: 10 }, { lux: 100, value: 20 }],
  ...extra,
});
const config = (extra = {}) => ({
  brightness: settings(), demo: false, zone: 'Europe/Berlin',
  haUrl: 'https://ha.example', haToken: 'ha-private', ...extra,
});
function sample() {
  const state = (state, attributes) => ({ state, attributes, last_reported: reported, last_changed: reported });
  return {
    receivedAt: 0,
    lux: state('100', { unit_of_measurement: 'lx' }),
    backlight: state('10', { min: 0, max: 50, step: 1 }),
    tv: state('on', { app_id: 'FrameHs001.Dashboard', art_mode_status: 'off' }),
  };
}
const context = (extra = {}) => ({ wall, monotonic: 0, lease: { foreground: true }, zone: 'Europe/Berlin', ...extra });
function haFetcher(calls = [], transform = (state) => state) {
  const states = sample();
  return async (url, options) => {
    calls.push({ url: String(url), options });
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, 'Bearer ha-private');
    const key = { 'sensor.room_lux': 'lux', 'number.screen_backlight': 'backlight', 'media_player.screen': 'tv' }[decodeURIComponent(url.pathname.split('/').at(-1))];
    assert.ok(key, 'only configured entity state paths may be read');
    assert.match(url.pathname, /^\/api\/states\//);
    return new Response(JSON.stringify(transform({ ...states[key], entity_id: decodeURIComponent(url.pathname.split('/').at(-1)) })));
  };
}

test('brightness configuration is explicit, strict and preserves flat presentation settings', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-brightness-config-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  await fs.writeFile(file, JSON.stringify({ layout: 'salon', brightness: { enabled: false } }));
  const parsed = await loadConfig({ DEMO_MODE: 'true', DASHBOARD_CONFIG: file });
  assert.equal(parsed.presentation.layout, 'salon');
  assert.equal(parsed.brightness.enabled, false);
  for (const bad of [null, { enabled: true }, { enabled: false, write: true }]) assert.throws(() => parseBrightness(bad));
  for (const bad of [
    { min: 21, max: 20 }, { luxEntity: 'number.wrong' }, { heartbeatSeconds: 20 },
    { curve: [{ lux: 1, value: 20 }, { lux: 1, value: 10 }] },
    { night: { start: '22:00', end: '06:00', max: 9 } },
  ]) assert.throws(() => settings(bad));
  await fs.writeFile(file, JSON.stringify({ brightness: settings() }));
  await assert.rejects(loadConfig({ DEMO_MODE: 'true', DASHBOARD_CONFIG: file }), /forbidden_in_demo/);
  const production = {
    DEMO_MODE: 'false', DASHBOARD_CONFIG: file, HA_URL: 'https://ha.example', HA_TOKEN: 'ha-private',
    MACHBAR_URL: 'https://tasks.example', MACHBAR_TOKEN: 'source', HA_CALENDAR_ENTITIES: 'calendar.family',
    PUBLIC_URL: 'https://frame.example', OIDC_ISSUER: 'https://id.example',
    OIDC_CLIENT_ID: 'client', OIDC_CLIENT_SECRET: 'secret', OIDC_ALLOWED_SUBJECTS: 'household',
    DISPLAY_TOKEN: 'd'.repeat(32), WORKER_TOKEN: 'w'.repeat(32), ADMIN_TOKEN: 'a'.repeat(32),
  };
  await assert.rejects(loadConfig(production), /BRIGHTNESS_TELEMETRY_TOKEN/);
  await assert.rejects(loadConfig({ ...production, BRIGHTNESS_TELEMETRY_TOKEN: production.ADMIN_TOKEN }), /distinct/);
  assert.equal((await loadConfig({ ...production, BRIGHTNESS_TELEMETRY_TOKEN: 't'.repeat(32) })).brightness.enabled, true);
  assert.throws(() => brightnessConnection({ DEMO_MODE: 'true' }, settings()), /forbidden_in_demo/);
});

test('candidate interpolation, smoothing, deadband, native bounds and optional Berlin night cap', () => {
  const options = settings({ smoothingSeconds: 30, minChangeSeconds: 0 });
  assert.equal(curveValue(options.curve, 0), 10);
  assert.equal(curveValue(options.curve, 1000), 20);
  assert.ok(Math.abs(curveValue(options.curve, Math.sqrt(101) - 1) - 15) < 0.00001);
  const first = sample();
  first.lux.state = '0';
  const initial = evaluateBrightness(options, first, {}, context());
  assert.equal(initial.status.decision, 'within_deadband');
  const later = sample();
  later.receivedAt = 30000;
  const second = evaluateBrightness(options, later, initial.memory, context({ monotonic: 30000 }));
  assert.ok(second.status.smoothedLux > 63 && second.status.smoothedLux < 64);
  assert.equal(second.status.decision, 'would_change');
  assert.equal(second.status.writes_supported, false);
  assert.equal(evaluateBrightness(options, later, second.memory, context({ monotonic: 31000 })).status.smoothedLux, second.status.smoothedLux);
  const capped = evaluateBrightness(settings({ night: { start: '18:00', end: '06:00', max: 12 } }), sample(), {}, context());
  assert.equal(capped.status.candidate, 12);
  assert.equal(evaluateBrightness(settings(), sample(), {}, context()).status.decision, 'minimum_interval');
  const delayed = sample();
  delayed.receivedAt = 60000;
  assert.equal(evaluateBrightness(settings(), delayed, initial.memory, context({ monotonic: 60000 })).status.decision, 'would_change');
});

test('unknown, stale, malformed and conflicting inputs block eligibility and reset lost input smoothing', () => {
  const cases = [
    ['lux', 'state', '-1', 'lux_invalid'], ['lux', 'state', 'NaN', 'lux_invalid'],
    ['lux', 'state', 'Infinity', 'lux_invalid'], ['lux', 'state', '', 'lux_invalid'],
    ['backlight', 'state', 'unavailable', 'backlight_unavailable'],
    ['backlight', 'state', '51', 'backlight_invalid'],
    ['tv', 'state', 'off', 'tv_not_on'],
    ['lux', 'last_reported', undefined, 'lux_report_freshness_unknown'],
    ['tv', 'last_reported', new Date(wall - 121000).toISOString(), 'tv_report_stale'],
    ['lux', 'last_reported', new Date(wall + 1000).toISOString(), 'lux_report_freshness_unknown'],
  ];
  for (const [entity, key, value, reason] of cases) {
    const states = sample();
    states[entity][key] = value;
    const result = evaluateBrightness(settings(), states, { smoothed: 1 }, context());
    assert.ok(result.status.reasons.includes(reason), reason);
    assert.equal(result.status.eligible, false);
  }
  for (const attributes of [
    { app_id: 'other', art_mode_status: 'off' },
    { app_id: 'art', art_mode_status: 'on' },
    { app_id: 'FrameHs001.Dashboard' },
  ]) {
    const states = sample();
    states.tv.attributes = attributes;
    assert.equal(evaluateBrightness(settings(), states, {}, context()).status.eligible, false);
  }
  const stale = evaluateBrightness(settings(), sample(), {}, context({ monotonic: 61000, lease: { foreground: false } }));
  assert.ok(stale.status.reasons.includes('observation_stale'));
  assert.ok(stale.status.reasons.includes('foreground_lease_missing'));
  assert.deepEqual(stale.memory, {});
  assert.ok(evaluateBrightness(settings({ curve: [] }), sample(), {}, context()).status.reasons.includes('curve_not_configured'));
  const states = sample();
  states.lux.attributes.unit_of_measurement = '%';
  assert.ok(evaluateBrightness(settings(), states, {}, context()).status.reasons.includes('lux_invalid'));
  states.backlight.attributes.step = 2;
  assert.ok(evaluateBrightness(settings(), states, {}, context()).status.reasons.includes('backlight_invalid'));
});

test('foreground leases expire on monotonic receipt time, reject replay and cannot survive restart or supersession', () => {
  let now = 0;
  const lease = new ForegroundLease(settings(), () => now);
  const first = lease.challenge();
  assert.equal(lease.status().foreground, false);
  assert.equal(lease.report({ ...first, action: 'report', sequence: 1 }), true);
  assert.equal(lease.report({ ...first, action: 'report', sequence: 1 }), false);
  const second = lease.challenge();
  assert.equal(lease.status().foreground, false);
  assert.equal(lease.report({ ...first, action: 'report', sequence: 2 }), false);
  assert.equal(lease.report({ ...second, action: 'report', sequence: 1 }), true);
  now = 30000;
  assert.equal(lease.status().foreground, false);
  assert.equal(lease.report({ ...second, action: 'report', sequence: 2 }), false);
  assert.equal(new ForegroundLease(settings()).report({ ...second, action: 'report', sequence: 2 }), false);
  const third = lease.challenge();
  lease.report({ ...third, action: 'report', sequence: 1 });
  assert.equal(lease.report({ ...third, action: 'release', sequence: 2 }), true);
  assert.equal(lease.status().foreground, false);
});

test('HA transport only reads three configured states and strips unrelated household attributes', async () => {
  const calls = [];
  const values = await readBrightness(config(), { fetcher: haFetcher(calls, (state) => ({ ...state, attributes: { ...state.attributes, private: 'do-not-keep' } })) });
  assert.equal(calls.length, 3);
  assert.doesNotMatch(JSON.stringify(values), /do-not-keep|entity_id/);
  await assert.rejects(readBrightness(config(), { fetcher: haFetcher([], () => ({ entity_id: 'sensor.wrong', state: '1' })) }), /state_invalid/);
  await assert.rejects(readBrightness(config(), { fetcher: async () => new Response('private response', { status: 401 }) }), /source_unauthorized/);
  const abort = new AbortController();
  const waiting = readBrightness(config(), {
    signal: abort.signal,
    fetcher: (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  abort.abort();
  await assert.rejects(waiting, /abort/i);
});

test('observer coalesces reads, expires diagnostic evidence, surfaces failures and never contacts HA when disabled', async () => {
  let now = 0;
  const calls = [];
  const warnings = [];
  let failing = false;
  const fetcher = haFetcher(calls);
  const observer = new BrightnessObserver(config(), {
    wall: () => wall, clock: () => now,
    fetcher: (...args) => { if (failing) throw new Error('private-error'); return fetcher(...args); },
    log: (...args) => warnings.push(args),
  });
  const first = observer.refresh();
  assert.equal(observer.refresh(), first);
  await first;
  assert.equal(calls.length, 3);
  assert.ok(observer.status().reasons.includes('foreground_lease_missing'));
  now = 61000;
  assert.ok(observer.status().reasons.includes('observation_stale'));
  failing = true;
  await observer.refresh();
  assert.equal(observer.status().error, 'ha_observation_failed');
  assert.equal(observer.status().current, null);
  assert.doesNotMatch(JSON.stringify(warnings), /private-error/);
  await observer.close();
  const disabled = new BrightnessObserver(config({ brightness: parseBrightness() }), { fetcher: () => assert.fail('disabled HA request') });
  disabled.start();
  await disabled.refresh();
  await disabled.close();
  assert.equal(disabled.timer, null);
  assert.throws(() => new BrightnessObserver(config({ demo: true })), /forbidden_in_demo/);
});

test('telemetry API isolates roles and origin handling, validates payloads, and never enables TV writes', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-brightness-api-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const baseConfig = await loadConfig({ DEMO_MODE: 'true' });
  const cfg = {
    ...baseConfig, ...config(), dataDir: dir, publicUrl: 'https://frame.example', subjects: [],
    displayToken: 'd'.repeat(32), workerToken: 'w'.repeat(32), adminToken: 'a'.repeat(32), telemetryToken: 't'.repeat(32),
  };
  const auth = new Authentication(cfg);
  for (const role of ['display', 'worker', 'admin', 'human', 'demo', null]) assert.equal(auth.can(role, 'telemetry'), false);
  for (const capability of ['display', 'render', 'admin', 'tv-write']) assert.equal(auth.can('telemetry', capability), false);
  const observer = new BrightnessObserver(cfg, { fetcher: haFetcher(), wall: () => wall });
  const app = await createDashboard(cfg, { runtime: new Runtime({ ...baseConfig, dataDir: dir }), observer, auth });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const headers = { authorization: `Bearer ${cfg.telemetryToken}`, 'content-type': 'application/json', origin: 'null' };
  const post = (body, extra = {}) => fetch(`${base}/api/brightness/lease`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  for (const token of ['', cfg.displayToken, cfg.workerToken, cfg.adminToken]) {
    assert.ok([401, 403].includes((await post({ action: 'challenge' }, { authorization: `Bearer ${token}` })).status));
  }
  const preflight = await fetch(`${base}/api/brightness/lease`, {
    method: 'OPTIONS', headers: { origin: 'null', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
  assert.equal((await post({ action: 'challenge' }, { origin: 'https://other.example' })).status, 403);
  assert.equal((await post({ action: 'challenge', extra: true })).status, 400);
  assert.equal((await post({ action: 'challenge' }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await fetch(`${base}/api/brightness/lease`, { method: 'POST', headers, body: 'x'.repeat(1025) })).status, 413);
  const challenge = await (await post({ action: 'challenge' })).json();
  assert.match(challenge.id, /^[a-f0-9]{64}$/);
  const report = { action: 'report', id: challenge.id, sequence: 1 };
  assert.equal((await post(report)).status, 200);
  assert.equal((await post(report)).status, 409);
  assert.equal((await post({ ...report, sequence: 2, timestamp: 'forged' })).status, 400);
  assert.equal((await fetch(`${base}/api/brightness/status`, { headers })).status, 403);
  assert.equal((await fetch(`${base}/api/week`, { headers })).status, 403);
  const status = await (await fetch(`${base}/api/brightness/status`, { headers: { authorization: `Bearer ${cfg.adminToken}` } })).json();
  assert.equal(status.mode, 'observe');
  assert.equal(status.writes_supported, false);
  assert.equal(status.lease.foreground, true);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(`${cfg.telemetryToken}|${challenge.id}`));
  const ordinary = await fetch(`${base}/api/health`, { headers: { authorization: `Bearer ${cfg.adminToken}`, origin: 'null' } });
  assert.equal(ordinary.headers.get('access-control-allow-origin'), null);
});

test('HA-only CLI refuses fixture mode without contacting a source or requiring content credentials', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-observe-cli-'));
  try {
    const file = path.join(directory, 'config.json');
    await fs.writeFile(file, JSON.stringify({ brightness: settings() }));
    await assert.rejects(promisify(execFile)(process.execPath, ['scripts/brightness.mjs'], {
      cwd: new URL('..', import.meta.url),
      env: { PATH: process.env.PATH, DEMO_MODE: 'true', DASHBOARD_CONFIG: file },
    }), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /non-demo HA connection/);
      assert.equal(error.stdout, '');
      return true;
    });

  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('HA-only CLI reads synthetic loopback states without content credentials and cannot establish ownership', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-observe-live-contract-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'config.json');
  await fs.writeFile(file, JSON.stringify({ brightness: settings() }));
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    assert.equal(req.method, 'GET');
    assert.equal(req.headers.authorization, 'Bearer ha-private');
    const entity = req.url.split('/').at(-1);
    const key = { 'sensor.room_lux': 'lux', 'number.screen_backlight': 'backlight', 'media_player.screen': 'tv' }[entity];
    assert.ok(key);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ...sample()[key], entity_id: entity, last_reported: new Date().toISOString() }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['scripts/brightness.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      PATH: process.env.PATH, DEMO_MODE: 'false', DASHBOARD_CONFIG: file,
      HA_URL: `http://127.0.0.1:${server.address().port}`, HA_TOKEN: 'ha-private',
    },
  });
  assert.equal(stderr, '');
  const status = JSON.parse(stdout);
  assert.equal(requests.length, 3);
  assert.equal(status.error, null);
  assert.equal(status.writes_supported, false);
  assert.equal(status.candidate, 20);
  assert.equal(status.eligible, false);
  assert.ok(status.reasons.includes('foreground_lease_missing'));
  assert.doesNotMatch(stdout, /ha-private|sensor\.room_lux/);
});
