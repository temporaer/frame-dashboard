import { Temporal } from '@js-temporal/polyfill';
import { randomBytes } from 'node:crypto';

export class ForegroundLease {
  constructor(config, clock = () => performance.now()) {
    this.config = config;
    this.clock = clock;
    this.session = null;
  }

  challenge() {
    const id = randomBytes(32).toString('hex');
    this.session = { id, sequence: 0, expires: this.clock() + this.config.leaseSeconds * 1000, reported: false };
    return { id, leaseSeconds: this.config.leaseSeconds, heartbeatSeconds: this.config.heartbeatSeconds };
  }

  report({ id, sequence, action }) {
    const session = this.session;
    if (!session || session.id !== id || this.clock() >= session.expires || sequence <= session.sequence) return false;
    session.sequence = sequence;
    if (action === 'release') {
      this.session = null;
    } else {
      session.reported = true;
      session.expires = this.clock() + this.config.leaseSeconds * 1000;
    }
    return true;
  }

  status() {
    const session = this.session;
    const remaining = session ? Math.max(0, session.expires - this.clock()) : 0;
    return { foreground: Boolean(session?.reported && remaining > 0), remainingSeconds: remaining / 1000 };
  }

  clear() { this.session = null; }
}

function ageSeconds(timestamp, now) {
  if (typeof timestamp !== 'string') return null;
  const age = (now - Date.parse(timestamp)) / 1000;
  return Number.isFinite(age) && age >= 0 ? age : null;
}

function numeric(state) {
  return typeof state?.state === 'string' && state.state.trim() !== '' && Number.isFinite(Number(state.state))
    ? Number(state.state) : null;
}

export function curveValue(curve, lux) {
  if (!curve.length) return null;
  if (lux <= curve[0].lux) return curve[0].value;
  for (let index = 1; index < curve.length; index++) {
    const upper = curve[index];
    const lower = curve[index - 1];
    if (lux <= upper.lux) {
      const ratio = (Math.log1p(lux) - Math.log1p(lower.lux)) / (Math.log1p(upper.lux) - Math.log1p(lower.lux));
      return lower.value + ratio * (upper.value - lower.value);
    }
  }
  return curve.at(-1).value;
}

export function evaluateBrightness(config, sample, previous, { wall, monotonic, lease, zone }) {
  const reasons = [];
  const ages = {};
  for (const key of ['lux', 'backlight', 'tv']) {
    const state = sample?.[key];
    const reportAge = ageSeconds(state?.last_reported, wall);
    ages[key] = { reportSeconds: reportAge, changeSeconds: ageSeconds(state?.last_changed, wall) };
    if (!state || ['unknown', 'unavailable'].includes(state.state)) reasons.push(`${key}_unavailable`);
    if (reportAge === null) reasons.push(`${key}_report_freshness_unknown`);
    else if (reportAge > config[`${key}MaxAgeSeconds`]) reasons.push(`${key}_report_stale`);
  }
  const observationAge = sample ? Math.max(0, (monotonic - sample.receivedAt) / 1000) : null;
  if (observationAge === null || observationAge > config.pollSeconds * 2) reasons.push('observation_stale');
  const lux = numeric(sample?.lux);
  const current = numeric(sample?.backlight);
  const meta = sample?.backlight?.attributes;
  if (lux === null || lux < 0 || sample?.lux?.attributes?.unit_of_measurement !== 'lx') reasons.push('lux_invalid');
  const backlightValid = current !== null && Number.isInteger(current) && meta &&
    typeof meta.min === 'number' && meta.min === 0 && meta.max === 50 && meta.step === 1 &&
    current >= meta.min && current <= meta.max;
  if (!backlightValid) reasons.push('backlight_invalid');
  const tv = sample?.tv;
  if (tv?.state !== 'on') reasons.push('tv_not_on');
  if (tv?.attributes?.app_id !== config.appId) reasons.push('own_app_unconfirmed');
  if (tv?.attributes?.[config.artAttribute] !== 'off' || tv?.attributes?.app_id === 'art') reasons.push('art_off_unconfirmed');
  if (!lease.foreground) reasons.push('foreground_lease_missing');
  if (!config.curve.length) reasons.push('curve_not_configured');

  const inputValid = !reasons.some((reason) => /^(lux_|backlight_|observation_)/.test(reason));
  const continuous = previous.sampleAt !== undefined && monotonic - previous.sampleAt <= config.pollSeconds * 2000;
  let memory = inputValid && continuous ? { ...previous } : {};
  let smoothed = null;
  let candidate = null;
  let decision = 'blocked';
  if (inputValid) {
    if (memory.sampleAt !== sample.receivedAt) {
      const elapsed = memory.sampleAt === undefined ? 0 : Math.max(0, (sample.receivedAt - memory.sampleAt) / 1000);
      const alpha = config.smoothingSeconds === 0 ? 1 : -Math.expm1(-elapsed / config.smoothingSeconds);
      memory.smoothed = memory.smoothed === undefined ? lux : memory.smoothed + alpha * (lux - memory.smoothed);
      memory.sampleAt = sample.receivedAt;
      if (memory.current !== current) memory.changedAt = monotonic;
      memory.current = current;
    }
    smoothed = memory.smoothed;
    const proposed = curveValue(config.curve, smoothed);
    if (proposed !== null) {
      let cap = config.max;
      if (config.night) {
        const time = Temporal.Instant.fromEpochMilliseconds(wall).toZonedDateTimeISO(zone).toPlainTime().toString().slice(0, 5);
        const { start, end, max } = config.night;
        if (start < end ? time >= start && time < end : time >= start || time < end) cap = max;
      }
      candidate = Math.round(Math.max(config.min, Math.min(cap, proposed)));
    }
    if (!reasons.length) {
      decision = Math.abs(candidate - current) <= config.deadband ? 'within_deadband' :
        monotonic - memory.changedAt < config.minChangeSeconds * 1000 ? 'minimum_interval' : 'would_change';
    }
  }
  return {
    memory,
    status: {
      mode: 'observe', writes_supported: false, enabled: true,
      eligible: reasons.length === 0, reasons, decision,
      lux, smoothedLux: smoothed, current, candidate,
      ages, observationAgeSeconds: observationAge, lease,
    },
  };
}
