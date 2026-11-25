import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { demoSources } from '../lib/demo.js';
import { buildProjection, fingerprint } from '../lib/projection.js';
import { Runtime } from '../lib/runtime.js';
import { artFor } from '../lib/art.js';
import { createDashboard } from '../lib/server.js';
import { Authentication } from '../lib/authentication.js';

const now = '2026-11-25T10:00:00Z';
const zone = 'Europe/Berlin';
const demoConfig = (extra = {}) => loadConfig({ DEMO_MODE: 'true', ...extra });

test('configuration fails closed and rejects conflicting or invalid preferences', async () => {
  await assert.rejects(loadConfig({}), /MACHBAR_URL/);
  await assert.rejects(demoConfig({ MACHBAR_REFRESH_SECONDS: '0' }));
  await assert.rejects(demoConfig({ DEMO_MODE: 'yes' }));
  await assert.rejects(demoConfig({ TZ: 'UTC', DASHBOARD_TZ: zone }), /disagree/);
  await assert.rejects(demoConfig({ EVENING_TRANSITION: '25:01' }));
  await assert.rejects(demoConfig({ HA_CALENDAR_ENTITIES: 'sensor.secret' }));
  await assert.rejects(demoConfig({ TZ: 'Invalid/Zone' }));
});

test('projection excludes available/private work, preserves effective-owner narrowing and attention', async () => {
  const config = await demoConfig();
  const data = demoSources(now, zone);
  const day = data.machbar.days.find((d) => d.date === data.range.today);
  const base = day.tasks[0];
  day.tasks.push({ ...base, id: 'task:90', scope: 'work' });
  day.tasks.push({ ...base, id: 'task:91', privacyOwnerMemberId: 1 });
  const options = { config, now, machbar: data.machbar, events: data.events, health: [] };
  const projected = buildProjection(options);
  const tasks = projected.days.find((d) => d.date === data.range.today).tasks;
  assert.equal(tasks.length, 6);
  assert.equal(tasks[0].tag, 'Überfällig');
  assert.ok(!tasks.some((t) => t.id === 'task:90' || t.id === 'task:91'));
  config.presentation.ownerIds = [null];
  assert.ok(!buildProjection(options).days.find((d) => d.date === data.range.today).tasks.some((t) => t.id === 'task:2'));
});

test('fingerprint ignores polling timestamps but changes at visible transitions and build updates', async () => {
  const config = await demoConfig();
  const runtime = new Runtime(config, { clock: () => now });
  const first = runtime.snapshot();
  const later = runtime.snapshot({ now: '2026-11-25T10:01:00Z' });
  assert.equal(fingerprint(first, 'a'), fingerprint(later, 'a'));
  assert.notEqual(fingerprint(first, 'a'), fingerprint(first, 'b'));
  assert.notEqual(fingerprint(first), fingerprint(runtime.snapshot({ now: '2026-11-25T18:00:00Z' })));
  assert.equal(runtime.snapshot({ variant: 'quiet' }).days.flatMap((d) => d.tasks).length, 0);
});

test('source failures are independent and retain visibly stale last-good data across restart', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-cache-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = { ...await demoConfig(), demo: false, dataDir: dir, machbarUrl: 'https://tasks.example', machbarToken: 'hidden', haUrl: 'https://calendar.example', haToken: 'hidden', calendars: ['calendar.family'] };
  let fail = false;
  const fetcher = async (url) => {
    if (fail && url.hostname === 'tasks.example') return new Response('sensitive upstream message', { status: 503 });
    return new Response(JSON.stringify(url.hostname === 'tasks.example' ? demoSources(now, zone).machbar : []));
  };
  const runtime = new Runtime(config, { clock: () => now, fetcher });
  await runtime.init();
  await runtime.refreshAll();
  fail = true;
  await runtime.refreshAll();
  const projected = runtime.snapshot();
  assert.equal(projected.health[0].state, 'stale');
  assert.equal(projected.health[1].state, 'ok');
  assert.ok(projected.days.some((d) => d.tasks.length));
  const restarted = new Runtime(config, { clock: () => now, fetcher });
  await restarted.init();
  assert.equal(restarted.snapshot().health[0].state, 'stale');
  assert.equal(JSON.stringify(projected).includes('sensitive upstream'), false);
});

test('art rotation stays deterministic with local fallbacks for remote packs', () => {
  assert.deepEqual(artFor('2026-11-25'), artFor('2026-11-25'));
  const remote = Array.from({ length: 60 }, (_, i) => artFor(`2026-11-${String(i % 28 + 1).padStart(2, '0')}`)).find((a) => a.image.startsWith('art-cache/'));
  assert.ok(remote?.fallback.image.startsWith('art/'));
});

test('HTTP isolates capabilities, requires browser login and never serves old write routes', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-http-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = { ...await demoConfig(), demo: false, dataDir: dir, publicUrl: 'https://frame.example', subjects: ['household-sub'], displayToken: 'display-secret', workerToken: 'worker-secret', adminToken: 'admin-secret', calendars: [] };
  const runtime = new Runtime({ ...config, demo: true }, { clock: () => now });
  const app = await createDashboard(config, { runtime });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(base, { redirect: 'manual' })).status, 302);
  assert.equal((await fetch(`${base}/api/week`)).status, 401);
  assert.equal((await fetch(`${base}/api/week?k=display-secret`)).status, 401);
  const read = { headers: { authorization: 'Bearer display-secret' } };
  assert.equal((await fetch(`${base}/api/week`, read)).status, 200);
  assert.equal((await fetch(`${base}/api/refresh`, { ...read, method: 'POST' })).status, 403);
  assert.equal((await fetch(`${base}/api/render-snapshot`, read)).status, 403);
  assert.equal((await fetch(`${base}/api/week`, { headers: { authorization: 'Bearer worker-secret' } })).status, 403);
  assert.equal((await fetch(`${base}/api/render-snapshot`, { headers: { authorization: 'Bearer worker-secret' } })).status, 200);
  assert.equal((await fetch(`${base}/api/plan`, { method: 'PUT', headers: { authorization: 'Bearer admin-secret' } })).status, 405);
  assert.equal((await fetch(`${base}/.env.local`)).status, 404);
  assert.equal((await fetch(`${base}/public/../../package.json`)).status, 404);
  assert.equal((await fetch(`${base}/display`)).status, 200);
});

test('OIDC verifies nonce, state, PKCE and explicit subject authorization', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-oidc-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let received;
  const provider = {
    discovery: async () => ({}), ClientSecretPost: () => ({}),
    randomState: () => 'expected-state', randomNonce: () => 'expected-nonce',
    randomPKCECodeVerifier: () => 'verifier', calculatePKCECodeChallenge: async () => 'challenge',
    buildAuthorizationUrl: (_, params) => { received = params; return new URL('https://id.example/authorize'); },
    authorizationCodeGrant: async (_, callback, checks) => {
      assert.equal(callback.origin, 'https://frame.example');
      assert.deepEqual(checks, { expectedState: 'expected-state', expectedNonce: 'expected-nonce', pkceCodeVerifier: 'verifier', idTokenExpected: true });
      return { claims: () => ({ sub: 'allowed' }) };
    },
  };
  const auth = new Authentication({ dataDir: dir, issuer: 'https://id.example', clientId: 'client', clientSecret: 'secret', publicUrl: 'https://frame.example', subjects: ['allowed'] }, provider);
  const headers = {};
  const response = { setHeader: (k, v) => { headers[k] = v; }, writeHead: () => ({ end() {} }) };
  await auth.login(response);
  const flow = headers['set-cookie'].split(';')[0];
  assert.equal(received.code_challenge_method, 'S256');
  await auth.callback({ headers: { cookie: flow }, url: '/api/auth/callback?code=example&state=expected-state' }, response);
  assert.ok(headers['set-cookie'].includes('HttpOnly; Secure; SameSite=Lax'));
  assert.equal(await auth.role({ headers: { cookie: headers['set-cookie'].split(';')[0] } }), 'human');
  assert.equal(auth.checkMutation({ headers: { origin: 'https://evil.example' } }, 'human'), false);
  await assert.rejects(auth.callback({ headers: { cookie: flow }, url: '/api/auth/callback' }, response));
});
