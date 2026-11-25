import { z } from 'zod';

const report = {
  id: z.string().regex(/^[a-f0-9]{64}$/),
  sequence: z.number().int().min(1).max(2147483647),
};
const payload = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('challenge') }),
  z.strictObject({ action: z.literal('report'), ...report }),
  z.strictObject({ action: z.literal('release'), ...report }),
]);
const send = (res, code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));

function readBody(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    const finish = (error) => {
      clearTimeout(timer);
      req.removeListener('data', data);
      req.removeListener('end', end);
      req.removeListener('error', failed);
      req.removeListener('aborted', aborted);
      if (error) {
        req.resume();
        reject(error);
      } else {
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    };
    const data = (chunk) => {
      bytes += chunk.length;
      if (bytes > 1024) return finish(413);
      chunks.push(chunk);
    };
    const end = () => finish();
    const failed = () => finish(400);
    const aborted = () => finish(400);
    const timer = setTimeout(() => finish(408), 5000);
    req.on('data', data).on('end', end).on('error', failed).on('aborted', aborted);
  });
}

export async function brightnessLeaseRequest(req, res, { config, role, auth, observer, limited }) {
  if (!config.brightness?.enabled || config.demo) return send(res, 404, { error: 'brightness_disabled' });
  const origin = req.headers.origin;
  const originAllowed = origin === undefined || origin === 'null' || origin === new URL(config.publicUrl).origin;
  res.setHeader('vary', 'Authorization, Origin');
  if (!originAllowed) return send(res, 403, { error: 'origin_forbidden' });
  if (origin) res.setHeader('access-control-allow-origin', origin);
  if (req.method === 'OPTIONS') {
    const headers = (req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map((header) => header.trim()).filter(Boolean);
    if (req.headers['access-control-request-method'] !== 'POST' || headers.some((header) => !['authorization', 'content-type'].includes(header))) {
      return send(res, 403, { error: 'preflight_forbidden' });
    }
    res.setHeader('access-control-allow-methods', 'POST');
    res.setHeader('access-control-allow-headers', 'Authorization, Content-Type');
    return res.writeHead(204).end();
  }
  if (!auth.can(role, 'telemetry')) return send(res, role ? 403 : 401, { error: 'access_denied' });
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  if (limited(req, 'brightness-lease', 30)) return send(res, 429, { error: 'rate_limited' });
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json' || req.headers['content-encoding']) {
    return send(res, 415, { error: 'json_required' });
  }
  let value;
  try {
    value = payload.parse(JSON.parse(await readBody(req)));
  } catch (error) {
    const code = [408, 413].includes(error) ? error : 400;
    return send(res, code, { error: 'telemetry_request_invalid' });
  }
  if (value.action === 'challenge') return send(res, 200, observer.lease.challenge());
  if (!observer.lease.report(value)) return send(res, 409, { error: 'lease_expired_or_replayed' });
  return send(res, 200, { ok: true, mode: 'observe', writes_supported: false });
}
