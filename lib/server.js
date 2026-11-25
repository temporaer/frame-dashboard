import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Authentication } from './authentication.js';
import { ArtworkCache } from './art-cache.js';
import { Runtime } from './runtime.js';
import { fingerprint } from './projection.js';
import { writeState } from './storage.js';
import { Temporal } from '@js-temporal/polyfill';
import { buildIdentity } from './build.js';

const ROOT = path.resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.woff2': 'font/woff2' };
const log = (level, fields) => process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level, ...fields })}\n`);
const send = (res, status, value) => res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(value));

export async function createDashboard(config, { runtime = new Runtime(config, { log }), auth = new Authentication(config) } = {}) {
  await runtime.init();
  const cache = new ArtworkCache(config);
  const build = await buildIdentity(ROOT);
  const rate = new Map();
  function limited(req, action) {
    const key = `${req.socket.remoteAddress}:${action}`;
    const now = Date.now();
    if (rate.size > 1000) for (const [k, item] of rate) if (now - item.at >= 60000) rate.delete(k);
    const item = rate.get(key);
    if (!item || now - item.at >= 60000) { rate.set(key, { at: now, count: 1 }); return false; }
    return ++item.count > 10;
  }
  const server = http.createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('cache-control', 'private, no-store');
    res.setHeader('vary', 'Authorization, Cookie');
    res.setHeader('content-security-policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      const route = url.pathname;
      if (route === '/healthz') return send(res, 200, { status: 'ok' });
      if (req.method === 'GET' && route === '/api/auth/login' && !config.demo) {
        if (limited(req, 'login')) return send(res, 429, { error: 'rate_limited' });
        return await auth.login(res);
      }
      if (req.method === 'GET' && route === '/api/auth/callback' && !config.demo) return await auth.callback(req, res);
      const role = await auth.role(req);
      if (route === '/' && !auth.can(role, 'display')) {
        return res.writeHead(302, { location: '/api/auth/login' }).end();
      }
      if (route.startsWith('/api/')) {
        const capability = ['/api/render-snapshot'].includes(route) ? 'render' :
          ['/api/week', '/api/version'].includes(route) ? 'display' : 'admin';
        if (!auth.can(role, capability)) return send(res, role ? 403 : 401, { error: 'access_denied' });
        if (!['GET', 'HEAD'].includes(req.method) && !auth.checkMutation(req, role)) return send(res, 403, { error: 'origin_forbidden' });
        if (req.method === 'POST' && route === '/api/auth/logout') return await auth.logout(req, res);
        if (req.method === 'POST' && route === '/api/refresh') {
          if (limited(req, 'refresh')) return send(res, 429, { error: 'rate_limited' });
          await runtime.refreshAll();
          const health = runtime.snapshot().health;
          const ok = health.every((h) => h.state === 'ok');
          return send(res, ok ? 200 : 503, { ok, health });
        }
        if (req.method === 'POST' && route === '/api/art/activate') {
          if (!auth.can(role, 'tv-write') || !config.artEnabled) return send(res, 403, { error: 'art_disabled' });
          if (limited(req, 'activate')) return send(res, 429, { error: 'rate_limited' });
          await writeState(path.join(config.dataDir, 'art-control', 'activation.json'), { id: randomUUID(), requestedAt: new Date().toISOString() });
          return send(res, 202, { queued: true, wake: false });
        }
        if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
        if (route === '/api/health') {
          const health = runtime.snapshot().health;
          return send(res, health.every((h) => h.state === 'ok') ? 200 : 503, { health });
        }
        if (route === '/api/week' || route === '/api/render-snapshot' || route === '/api/version') {
          let now;
          let variant = 'day';
          if (route === '/api/render-snapshot' && config.demo) {
            if (url.searchParams.has('at')) now = Temporal.Instant.from(url.searchParams.get('at')).toString();
            variant = url.searchParams.get('variant') || 'day';
            if (!['day', 'quiet'].includes(variant)) return send(res, 400, { error: 'variant_invalid' });
          }
          const projection = runtime.snapshot({ now, variant });
          const version = fingerprint(projection, build);
          if (route === '/api/version') return send(res, 200, { build, version });
          if (route === '/api/render-snapshot') return send(res, 200, { build, fingerprint: version, projection });
          return send(res, 200, projection);
        }
        return send(res, 404, { error: 'not_found' });
      }
      if (!['GET', 'HEAD'].includes(req.method)) return send(res, 405, { error: 'method_not_allowed' });
      if (route === '/render' && !auth.can(role, 'render')) return send(res, 401, { error: 'access_denied' });
      if (route.startsWith('/art-cache/')) {
        const id = route.slice('/art-cache/'.length);
        if (!/^[a-f0-9]{64}$/.test(id)) return send(res, 404, { error: 'not_found' });
        const bytes = await cache.get(id);
        res.writeHead(200, { 'content-type': bytes[0] === 0xff ? 'image/jpeg' : 'image/png', 'cache-control': 'public, max-age=86400, immutable' }).end(bytes);
        return;
      }
      const name = ['/', '/display', '/render'].includes(route) ? 'index.html' : decodeURIComponent(route.slice(1));
      if (name === 'index.html' && !['/', '/display', '/render'].includes(route)) return send(res, 404, { error: 'not_found' });
      const file = path.resolve(ROOT, name);
      if (!file.startsWith(`${ROOT}${path.sep}`) || !TYPES[path.extname(file)]) return send(res, 404, { error: 'not_found' });
      let data;
      try { data = await fs.readFile(file); } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'EISDIR') return send(res, 404, { error: 'not_found' });
        throw error;
      }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] }).end(req.method === 'HEAD' ? undefined : data);
    } catch (error) {
      log('error', { event: 'request_failed', requestId, code: error instanceof RangeError ? 'input_invalid' : 'request_or_dependency_failed' });
      if (!res.headersSent) send(res, error instanceof RangeError ? 400 : 500, { error: 'request_failed', requestId });
      else res.destroy();
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return { server, runtime, log, async close() {
    await new Promise((resolve) => server.close(resolve));
    await runtime.close();
  } };
}
