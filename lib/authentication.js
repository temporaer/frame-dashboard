import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as oidc from 'openid-client';
import { readState, writeState } from './storage.js';

const SESSION = '__Host-frame-session';
const FLOW = '__Host-frame-flow';
const digest = (value) => createHash('sha256').update(value).digest('hex');
const fresh = () => randomBytes(32).toString('base64url');
function equal(a, b) {
  if (!a || !b) return false;
  return timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
}
function cookie(req, name) {
  const found = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name}=`));
  const value = found?.slice(name.length + 1);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
function setCookie(res, name, value, seconds) {
  res.setHeader('set-cookie', `${name}=${value}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Lax`);
}

export class Authentication {
  constructor(config, provider = oidc) {
    this.config = config;
    this.provider = provider;
    this.dir = path.join(config.dataDir, 'auth');
    this.discovered = null;
  }

  async configuration() {
    if (this.config.authMode === 'token') throw new Error('oidc_disabled');
    if (!this.discovered) {
      this.discovered = this.provider.discovery(
        new URL(this.config.issuer), this.config.clientId,
        { client_secret: this.config.clientSecret },
        this.provider.ClientSecretPost(this.config.clientSecret),
      ).catch((error) => { this.discovered = null; throw error; });
    }
    return this.discovered;
  }

  async role(req) {
    if (this.config.demo) return 'demo';
    const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
    if (bearer) {
      if (equal(bearer, this.config.displayToken)) return 'display';
      if (equal(bearer, this.config.workerToken)) return 'worker';
      if (equal(bearer, this.config.adminToken)) return 'admin';
      if (this.config.brightness?.enabled && equal(bearer, this.config.telemetryToken)) return 'telemetry';
      return null;
    }
    if (this.config.authMode === 'token') return null;
    const value = cookie(req, SESSION);
    if (!value) return null;
    const session = await readState(path.join(this.dir, `${digest(value)}.session.json`));
    if (!session || session.expires <= Date.now() || !this.config.subjects.includes(session.subject)) return null;
    return 'human';
  }

  can(role, capability) {
    if (!role) return false;
    if (capability === 'telemetry') return role === 'telemetry';
    if (role === 'telemetry') return false;
    if (role === 'demo') return capability !== 'tv-write';
    if (capability === 'display') return ['human', 'display', 'admin'].includes(role);
    if (capability === 'render') return ['worker', 'admin'].includes(role);
    return ['human', 'admin'].includes(role);
  }

  checkMutation(req, role) {
    return role !== 'human' || req.headers.origin === new URL(this.config.publicUrl).origin;
  }

  async prune() {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    for (const name of await fs.readdir(this.dir)) {
      if (!/^[a-f0-9]{64}\.(flow|session)\.json$/.test(name)) continue;
      const file = path.join(this.dir, name);
      const record = await readState(file);
      if (record.expires <= Date.now()) await fs.rm(file, { force: true });
    }
  }

  async login(res) {
    const configuration = await this.configuration();
    await this.prune();
    const flow = fresh();
    const state = this.provider.randomState();
    const nonce = this.provider.randomNonce();
    const verifier = this.provider.randomPKCECodeVerifier();
    const challenge = await this.provider.calculatePKCECodeChallenge(verifier);
    await writeState(path.join(this.dir, `${digest(flow)}.flow.json`), { state, nonce, verifier, expires: Date.now() + 600000 });
    setCookie(res, FLOW, flow, 600);
    const url = this.provider.buildAuthorizationUrl(configuration, {
      redirect_uri: `${this.config.publicUrl.replace(/\/$/, '')}/api/auth/callback`,
      response_type: 'code', scope: 'openid profile',
      code_challenge: challenge, code_challenge_method: 'S256', state, nonce,
    });
    res.writeHead(302, { location: url.toString() }).end();
  }

  async callback(req, res) {
    const value = cookie(req, FLOW);
    if (!value) throw new Error('oidc_flow_missing');
    const file = path.join(this.dir, `${digest(value)}.flow.json`);
    const flow = await readState(file);
    if (!flow || flow.expires <= Date.now()) throw new Error('oidc_flow_expired');
    await fs.unlink(file);
    const configuration = await this.configuration();
    const tokens = await this.provider.authorizationCodeGrant(
      configuration, new URL(req.url, this.config.publicUrl),
      { expectedState: flow.state, expectedNonce: flow.nonce, pkceCodeVerifier: flow.verifier, idTokenExpected: true },
    );
    const claims = tokens.claims();
    if (!claims?.sub || !this.config.subjects.includes(claims.sub)) throw new Error('oidc_subject_forbidden');
    const session = fresh();
    await writeState(path.join(this.dir, `${digest(session)}.session.json`), { subject: claims.sub, expires: Date.now() + 12 * 60 * 60 * 1000 });
    setCookie(res, SESSION, session, 12 * 60 * 60);
    res.writeHead(302, { location: '/' }).end();
  }

  async logout(req, res) {
    const value = cookie(req, SESSION);
    if (value) await fs.rm(path.join(this.dir, `${digest(value)}.session.json`), { force: true });
    setCookie(res, SESSION, '', 0);
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  }
}
