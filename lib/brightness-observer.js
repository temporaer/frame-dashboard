import { readBrightness } from './adapters/brightness-ha.js';
import { ForegroundLease, evaluateBrightness } from './brightness.js';

export class BrightnessObserver {
  constructor(config, { wall = Date.now, clock = () => performance.now(), fetcher = fetch, log = () => {} } = {}) {
    this.config = config;
    this.wall = wall;
    this.clock = clock;
    this.fetcher = fetcher;
    this.log = log;
    this.lease = new ForegroundLease(config.brightness, clock);
    this.memory = {};
    this.sample = null;
    this.timer = null;
    this.inflight = null;
    this.failures = 0;
    this.closed = false;
    this.running = false;
    this.abort = new AbortController();
    this.error = null;
    if (config.demo && config.brightness.enabled) throw new Error('brightness_live_observation_forbidden_in_demo');
  }

  refresh() {
    if (!this.config.brightness.enabled || this.closed) return Promise.resolve();
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const values = await readBrightness(this.config, { fetcher: this.fetcher, signal: this.abort.signal });
        if (this.closed) return;
        this.sample = { ...values, receivedAt: this.clock() };
        this.error = null;
        this.failures = 0;
        this.status();
      } catch {
        if (this.closed) return;
        this.sample = null;
        this.memory = {};
        this.error = 'ha_observation_failed';
        this.failures = Math.min(4, this.failures + 1);
        this.log('warn', { event: 'brightness_observation_failed', code: this.error });
      }
    })().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  status() {
    if (!this.config.brightness.enabled) return { mode: 'observe', writes_supported: false, enabled: false };
    const evaluated = evaluateBrightness(this.config.brightness, this.sample, this.memory, {
      wall: this.wall(), monotonic: this.clock(), lease: this.lease.status(), zone: this.config.zone,
    });
    this.memory = evaluated.memory;
    return { ...evaluated.status, error: this.error };
  }

  start() {
    if (!this.config.brightness.enabled || this.running || this.closed) return;
    this.running = true;
    const cycle = async () => {
      await this.refresh();
      if (this.closed) return;
      this.timer = setTimeout(cycle, Math.min(300, this.config.brightness.pollSeconds * 2 ** this.failures) * 1000);
      this.timer.unref();
    };
    void cycle();
  }

  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.lease.clear();
    this.abort.abort();
    await this.inflight;
    this.sample = null;
    this.memory = {};
  }
}
