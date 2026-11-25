import { z } from 'zod';
import { Temporal } from '@js-temporal/polyfill';

const entity = (domain) => z.string().regex(new RegExp(`^${domain}\\.[a-z0-9_]+$`));
const age = z.number().int().min(15).max(3600);
const clockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const schema = z.strictObject({
  enabled: z.boolean().default(false),
  luxEntity: entity('sensor').optional(),
  backlightEntity: entity('number').optional(),
  tvEntity: entity('media_player').optional(),
  appId: z.string().min(1).max(128).default('FrameHs001.Dashboard'),
  artAttribute: z.string().regex(/^[a-z][a-z0-9_]*$/).default('art_mode_status'),
  luxMaxAgeSeconds: age.optional(),
  backlightMaxAgeSeconds: age.optional(),
  tvMaxAgeSeconds: age.optional(),
  pollSeconds: z.number().int().min(15).max(300).default(30),
  leaseSeconds: z.number().int().min(15).max(120).default(30),
  heartbeatSeconds: z.number().int().min(5).max(30).default(10),
  smoothingSeconds: z.number().min(0).max(600).default(30),
  deadband: z.number().int().min(0).max(50).default(2),
  minChangeSeconds: z.number().int().min(0).max(3600).default(60),
  min: z.number().int().min(0).max(50).default(0),
  max: z.number().int().min(0).max(50).default(50),
  curve: z.array(z.strictObject({
    lux: z.number().min(0).max(1000000),
    value: z.number().int().min(0).max(50),
  })).max(32).default([]),
  night: z.strictObject({
    start: clockTime,
    end: clockTime,
    max: z.number().int().min(0).max(50),
  }).optional(),
}).superRefine((config, context) => {
  const invalid = (message) => context.addIssue({ code: 'custom', message });
  if (config.enabled) {
    for (const key of ['luxEntity', 'backlightEntity', 'tvEntity', 'luxMaxAgeSeconds', 'backlightMaxAgeSeconds', 'tvMaxAgeSeconds']) {
      if (config[key] === undefined) invalid(`brightness.${key} is required when enabled`);
    }
  }
  if (config.min > config.max) invalid('brightness bounds are reversed');
  if (config.heartbeatSeconds * 3 > config.leaseSeconds) invalid('brightness lease must cover at least three heartbeats');
  if (config.curve.length === 1) invalid('brightness curve needs at least two points');
  config.curve.forEach((point, index) => {
    const prior = config.curve[index - 1];
    if (point.value < config.min || point.value > config.max) invalid('brightness curve is outside bounds');
    if (prior && (prior.lux >= point.lux || prior.value > point.value)) invalid('brightness curve must be monotonic with distinct lux points');
  });
  if (config.night && (config.night.start === config.night.end || config.night.max < config.min || config.night.max > config.max)) {
    invalid('brightness night cap must have distinct times and lie inside bounds');
  }
});

export function parseBrightness(value) {
  return schema.parse(value === undefined ? {} : value);
}

export function brightnessConnection(env, brightness) {
  if (env.DEMO_MODE === 'true') throw new Error('brightness_live_observation_forbidden_in_demo');
  if (env.DEMO_MODE !== undefined && env.DEMO_MODE !== 'false') throw new Error('DEMO_MODE must be true or false');
  const url = new URL(env.HA_URL);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !env.HA_TOKEN) {
    throw new Error('brightness_connection_invalid');
  }
  const zone = env.TZ || env.DASHBOARD_TZ || 'Europe/Berlin';
  if (env.TZ && env.DASHBOARD_TZ && env.TZ !== env.DASHBOARD_TZ) throw new Error('TZ and DASHBOARD_TZ disagree');
  Temporal.Now.zonedDateTimeISO(zone);
  return { brightness, haUrl: url.toString(), haToken: env.HA_TOKEN, zone };
}
