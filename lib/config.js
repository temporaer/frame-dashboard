import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { Temporal } from '@js-temporal/polyfill';
import { parseBrightness } from './brightness-config.js';

const seconds = z.coerce.number().int().min(10).max(86400);
const token = z.string().min(32);
const connection = z.url().refine((value) => {
  if (!URL.canParse(value)) return false;
  const u = new URL(value);
  return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash;
});
export function loadCalendarConnection(env = process.env) {
  if (!connection.safeParse(env.HA_URL).success || !env.HA_TOKEN) throw new Error('Calendar discovery requires HA_URL and HA_TOKEN');
  return { haUrl: env.HA_URL, haToken: env.HA_TOKEN };
}
const presentationSchema = z.strictObject({
  layout: z.enum(['bleed', 'salon', 'painting']).default('bleed'),
  packs: z.array(z.string().regex(/^[a-z0-9-]+$/)).min(1).default(['impressionists']),
  eveningTransition: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).default('19:00'),
  maxVisibleTasks: z.number().int().min(1).max(8).default(5),
  showCompletedRecap: z.boolean().default(false),
  showRevisits: z.boolean().default(false),
  showOwners: z.boolean().default(false),
  ownerIds: z.array(z.number().int().positive().nullable()).default([]),
  projectIds: z.array(z.string()).default([]),
  tagIds: z.array(z.number().int().positive()).default([]),
  artworkCacheMB: z.number().int().min(32).max(4096).default(256),
});

export async function loadConfig(env = process.env) {
  let file = {};
  if (env.DASHBOARD_CONFIG) file = JSON.parse(await fs.readFile(env.DASHBOARD_CONFIG, 'utf8'));
  const { brightness: rawBrightness, ...presentationFile } = file;
  const brightness = parseBrightness(rawBrightness);
  const presentation = presentationSchema.parse({
    ...presentationFile,
    ...(env.EVENING_TRANSITION ? { eveningTransition: env.EVENING_TRANSITION } : {}),
    ...(env.MAX_VISIBLE_TASKS ? { maxVisibleTasks: Number(env.MAX_VISIBLE_TASKS) } : {}),
  });
  if (env.DEMO_MODE !== undefined && !['true', 'false'].includes(env.DEMO_MODE)) throw new Error('DEMO_MODE must be true or false');
  if (env.ART_MODE_ENABLED !== undefined && !['true', 'false'].includes(env.ART_MODE_ENABLED)) throw new Error('ART_MODE_ENABLED must be true or false');
  if (env.TZ && env.DASHBOARD_TZ && env.TZ !== env.DASHBOARD_TZ) throw new Error('TZ and DASHBOARD_TZ disagree');
  const zone = env.TZ || env.DASHBOARD_TZ || 'Europe/Berlin';
  Temporal.Now.zonedDateTimeISO(zone);
  const locale = env.DASHBOARD_LOCALE || 'de-DE';
  new Intl.DateTimeFormat(locale);
  const config = {
    demo: env.DEMO_MODE === 'true',
    brightness,
    telemetryToken: env.BRIGHTNESS_TELEMETRY_TOKEN || '',
    artEnabled: env.ART_MODE_ENABLED === 'true',
    host: env.HOST || '127.0.0.1',
    port: z.coerce.number().int().min(0).max(65535).parse(env.PORT ?? 4321),
    zone, locale, presentation,
    dataDir: path.resolve(env.DATA_DIR || 'data'),
    machbarSeconds: seconds.parse(env.MACHBAR_REFRESH_SECONDS ?? 60),
    calendarSeconds: seconds.parse(env.CALENDAR_REFRESH_SECONDS ?? 300),
    liveSeconds: seconds.parse(env.LIVE_REFRESH_SECONDS ?? 60),
    artSeconds: seconds.parse(env.ART_EVALUATION_SECONDS ?? 60),
    artMinSeconds: seconds.parse(env.ART_MIN_UPLOAD_INTERVAL_SECONDS ?? 300),
    staleMultiplier: z.coerce.number().min(1).max(100).parse(env.STALE_AFTER_INTERVALS ?? 3),
    machbarUrl: env.MACHBAR_URL || '',
    machbarTransport: z.enum(['rest', 'mcp']).parse(env.MACHBAR_TRANSPORT || (env.MACHBAR_MCP_ENDPOINT ? 'mcp' : 'rest')),
    machbarToken: env.MACHBAR_TOKEN || '',
    machbarMcpToken: env.MACHBAR_MCP_TOKEN || env.MACHBAR_TOKEN || '',
    machbarMcpEndpoint: env.MACHBAR_MCP_ENDPOINT || '',
    haUrl: env.HA_URL || '',
    haToken: env.HA_TOKEN || '',
    calendars: (env.HA_CALENDAR_ENTITIES || '').split(',').map((s) => s.trim()).filter(Boolean),
    displayToken: env.DISPLAY_TOKEN || '',
    workerToken: env.WORKER_TOKEN || '',
    adminToken: env.ADMIN_TOKEN || '',
    authMode: z.enum(['token', 'oidc']).parse(env.AUTH_MODE || 'oidc'),
    publicUrl: env.PUBLIC_URL || '',
    issuer: env.OIDC_ISSUER || '',
    clientId: env.OIDC_CLIENT_ID || '',
    clientSecret: env.OIDC_CLIENT_SECRET || '',
    subjects: (env.OIDC_ALLOWED_SUBJECTS || '').split(',').map((s) => s.trim()).filter(Boolean),
  };
  if (brightness.enabled) {
    if (config.demo) throw new Error('brightness_live_observation_forbidden_in_demo');
    if (!token.safeParse(config.telemetryToken).success ||
        [config.displayToken, config.workerToken, config.adminToken, config.haToken, config.machbarToken, config.machbarMcpToken, config.clientSecret].includes(config.telemetryToken)) {
      throw new Error('BRIGHTNESS_TELEMETRY_TOKEN requires a distinct secret of at least 32 characters');
    }
  }
  if (!config.demo) {
    for (const [name, value] of Object.entries({
      ...(config.machbarTransport === 'mcp' && config.machbarMcpEndpoint
        ? { MACHBAR_MCP_ENDPOINT: config.machbarMcpEndpoint } : { MACHBAR_URL: config.machbarUrl }),
      HA_URL: config.haUrl,
      ...(config.authMode === 'oidc' || config.publicUrl ? { PUBLIC_URL: config.publicUrl } : {}),
      ...(config.authMode === 'oidc' ? { OIDC_ISSUER: config.issuer } : {}),
    })) {
      if (!connection.safeParse(value).success) throw new Error(`${name} must be a credential-free HTTP(S) base URL`);
    }
    if (config.authMode === 'oidc') {
      if (!config.publicUrl.startsWith('https://') || !config.issuer.startsWith('https://')) throw new Error('PocketID and PUBLIC_URL require trusted HTTPS');
      if (!config.clientId || !config.clientSecret || !config.subjects.length) throw new Error('PocketID client and allowed subjects are required in OIDC mode');
    }
    if (config.publicUrl && new URL(config.publicUrl).pathname !== '/') throw new Error('PUBLIC_URL must use a dedicated origin, not a subpath');
    if (brightness.enabled && !config.publicUrl.startsWith('https://')) throw new Error('Brightness telemetry requires a trusted HTTPS PUBLIC_URL');
    for (const name of ['displayToken', 'workerToken', 'adminToken']) {
      if (!token.safeParse(config[name]).success) throw new Error(`${name} requires at least 32 characters`);
    }
    if (new Set([config.displayToken, config.workerToken, config.adminToken]).size !== 3) throw new Error('Credentials must be distinct');
    const machbarCredential = config.machbarTransport === 'mcp' ? config.machbarMcpToken : config.machbarToken;
    if (!machbarCredential || !config.haToken) throw new Error('Upstream credentials are required');
    if (config.machbarTransport === 'mcp' && !(config.machbarMcpEndpoint || config.machbarUrl).startsWith('https://')) throw new Error('Machbar MCP requires trusted HTTPS');
    if (config.machbarTransport === 'rest' && config.machbarMcpEndpoint) throw new Error('MACHBAR_MCP_ENDPOINT conflicts with REST transport');
    if (config.machbarTransport === 'mcp' && zone !== 'Europe/Berlin') throw new Error('The current Machbar Today MCP tool uses Europe/Berlin working windows');
    if (config.machbarTransport === 'mcp' && [config.displayToken, config.workerToken, config.adminToken].includes(config.machbarMcpToken)) throw new Error('MACHBAR_MCP_TOKEN must be distinct from dashboard credentials');
    if (config.machbarTransport === 'mcp' && (presentation.showRevisits || presentation.showCompletedRecap)) throw new Error('Machbar MCP supports only current-day commitments and deadline attention');
    if (!config.calendars.length) throw new Error('HA_CALENDAR_ENTITIES is required');
  }
  for (const entity of config.calendars) if (!/^calendar\.[a-z0-9_]+$/.test(entity)) throw new Error('Invalid calendar entity ID');
  return Object.freeze(config);
}
