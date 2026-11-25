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
import { buildIdentity } from '../lib/build.js';
import { createHash } from 'node:crypto';

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

test('explicit token mode needs no PocketID or public origin, but still requires scoped secrets', async () => {
  const env = {
    AUTH_MODE: 'token', MACHBAR_URL: 'https://tasks.example', MACHBAR_TOKEN: 'source',
    HA_URL: 'https://calendar.example', HA_TOKEN: 'calendar-secret', HA_CALENDAR_ENTITIES: 'calendar.synthetic',
    DISPLAY_TOKEN: 'd'.repeat(32), WORKER_TOKEN: 'w'.repeat(32), ADMIN_TOKEN: 'a'.repeat(32),
  };
  const config = await loadConfig(env);
  assert.equal(config.authMode, 'token');
  assert.equal(config.publicUrl, '');
  assert.equal((await loadConfig({ ...env, PUBLIC_URL: 'http://frame.example' })).authMode, 'token');
  for (const patch of [
    { DISPLAY_TOKEN: '' }, { WORKER_TOKEN: env.DISPLAY_TOKEN },
    { AUTH_MODE: 'anonymous' }, { AUTH_MODE: 'oidc' },
    { PUBLIC_URL: 'http://frame.example/subpath' },
  ]) await assert.rejects(loadConfig({ ...env, ...patch }));
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

test('build identity invalidates cached renders after font or artwork changes at the same path', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-build-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'fonts'));
  await fs.writeFile(path.join(dir, 'fonts', 'face.woff2'), 'original font');
  await fs.writeFile(path.join(dir, 'painting.jpg'), 'original image');
  const original = await buildIdentity(dir);
  assert.equal(await buildIdentity(dir), original);
  await fs.writeFile(path.join(dir, 'fonts', 'face.woff2'), 'updated font');
  const fontChanged = await buildIdentity(dir);
  assert.notEqual(fontChanged, original);
  await fs.writeFile(path.join(dir, 'painting.jpg'), 'updated image');
  assert.notEqual(await buildIdentity(dir), fontChanged);
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

test('token-only HTTP serves a safe shell, denies anonymous data and old sessions, and isolates capabilities', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-token-auth-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = {
    ...await demoConfig(), demo: false, authMode: 'token', dataDir: dir,
    displayToken: 'display-secret', workerToken: 'worker-secret', adminToken: 'admin-secret', subjects: ['previous-household'],
  };
  const auth = new Authentication(config, { discovery: () => assert.fail('OIDC must not be contacted') });
  const sessionId = 's'.repeat(43);
  await fs.mkdir(path.join(dir, 'auth'), { recursive: true });
  await fs.writeFile(path.join(dir, 'auth', `${createHash('sha256').update(sessionId).digest('hex')}.session.json`), JSON.stringify({
    subject: 'previous-household', expires: Date.now() + 60000,
  }));
  const cookie = `__Host-frame-session=${sessionId}`;
  assert.equal(await auth.role({ headers: { cookie } }), null);
  await assert.rejects(auth.configuration(), /oidc_disabled/);
  const runtime = new Runtime({ ...config, demo: true }, { clock: () => now });
  const app = await createDashboard(config, { runtime, auth });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (route, secret, method = 'GET') => fetch(`${base}${route}`, { method, headers: secret ? { authorization: `Bearer ${secret}` } : {} });
  assert.equal((await request('/')).status, 200);
  assert.equal((await request('/api/week')).status, 401);
  assert.equal((await fetch(`${base}/api/week`, { headers: { cookie } })).status, 401);
  assert.equal((await request('/api/week', 'wrong-secret')).status, 401);
  for (const route of ['/api/auth/login', '/api/auth/callback']) assert.equal((await request(route)).status, 404);
  assert.equal((await request('/api/auth/logout', config.adminToken, 'POST')).status, 404);
  const response = await request('/api/week', config.displayToken);
  assert.equal(response.status, 200);
  const body = await response.text();
  for (const value of [config.displayToken, config.workerToken, config.adminToken]) assert.ok(!body.includes(value));
  assert.equal((await request('/api/refresh', config.displayToken, 'POST')).status, 403);
  assert.equal((await request('/api/render-snapshot', config.displayToken)).status, 403);
  assert.equal((await request('/api/week', config.workerToken)).status, 403);
  assert.equal((await request('/api/render-snapshot', config.workerToken)).status, 200);
  assert.equal((await request('/api/refresh', config.adminToken, 'POST')).status, 200);
  assert.equal((await request('/api/art/activate', config.adminToken, 'POST')).status, 403);
});
