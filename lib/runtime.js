import path from 'node:path';
import { createHash } from 'node:crypto';
import { fetchMachbar } from './adapters/machbar.js';
import { fetchCalendar } from './adapters/home-assistant.js';
import { buildProjection } from './projection.js';
import { demoSources } from './demo.js';
import { windowFor } from './dates.js';
import { readState, writeState } from './storage.js';

export class Runtime {
  constructor(config, { clock = () => new Date().toISOString(), fetcher = fetch, log = () => {} } = {}) {
    this.config = config;
    this.clock = clock;
    this.fetcher = fetcher;
    this.log = log;
    this.sources = new Map();
    this.inflight = new Map();
    this.timers = [];
    this.persistQueue = Promise.resolve();
    this.cacheIdentity = createHash('sha256').update(JSON.stringify([config.machbarUrl, config.haUrl, config.calendars])).digest('hex');
  }

  async init() {
    if (!this.config.demo) {
      const cached = await readState(path.join(this.config.dataDir, 'sources.json'));
      if (cached?.version === 1 && cached.zone === this.config.zone && cached.identity === this.cacheIdentity) {
        for (const [key, value] of Object.entries(cached.sources)) this.sources.set(key, value);
      }
    }
  }

  names() {
    return ['machbar', ...this.config.calendars.map((_, i) => `calendar:${i}`)];
  }

  async refresh(name) {
    if (this.config.demo) return;
    if (this.inflight.has(name)) return this.inflight.get(name);
    const operation = (async () => {
      const now = this.clock();
      const range = windowFor(now, this.config.zone);
      const prior = this.sources.get(name);
      try {
        const data = name === 'machbar'
          ? await fetchMachbar(this.config, range, this.fetcher)
          : await fetchCalendar(this.config, this.config.calendars[Number(name.split(':')[1])], range, this.fetcher);
        this.sources.set(name, { data, successAt: now, range, failed: false });
      } catch (error) {
        this.sources.set(name, { ...prior, failed: true });
        this.log('warn', { event: 'source_refresh_failed', source: name, code: /^source_[a-z0-9_]+$/.test(error.message) ? error.message : 'source_contract_or_connection_error' });
      }
    })().finally(() => this.inflight.delete(name));
    this.inflight.set(name, operation);
    await operation;
  }

  async refreshAll() {
    await Promise.all(this.names().map((name) => this.refresh(name)));
    if (!this.config.demo) await this.persist();
  }

  async persist() {
    const work = this.persistQueue.then(() => writeState(path.join(this.config.dataDir, 'sources.json'), {
      version: 1, zone: this.config.zone, identity: this.cacheIdentity, sources: Object.fromEntries(this.sources),
    }));
    this.persistQueue = work.catch(() => this.log('error', { event: 'cache_persist_failed' }));
    return work;
  }

  start() {
    if (this.config.demo) return;
    for (const name of this.names()) {
      const seconds = name === 'machbar' ? this.config.machbarSeconds : this.config.calendarSeconds;
      this.timers.push(setInterval(() => {
        this.refresh(name).then(() => this.persist()).catch(() => this.log('error', { event: 'cache_persist_failed' }));
      }, seconds * 1000).unref());
    }
  }

  async close() {
    this.timers.forEach(clearInterval);
    await Promise.all(this.inflight.values());
    if (!this.config.demo) await this.persist();
  }

  snapshot({ now = this.clock(), variant = 'day' } = {}) {
    if (this.config.demo) {
      const demo = demoSources(now, this.config.zone, variant);
      return buildProjection({
        config: this.config, now, machbar: demo.machbar, events: demo.events,
        health: ['Machbar', 'Familienkalender'].map((label, i) => ({ source: `demo:${i}`, label, state: 'ok', successAt: now })),
      });
    }
    const range = windowFor(now, this.config.zone);
    const health = this.names().map((source) => {
      const record = this.sources.get(source);
      const seconds = source === 'machbar' ? this.config.machbarSeconds : this.config.calendarSeconds;
      const covers = record?.range.start <= range.start && record?.range.end >= range.end;
      const expired = Date.parse(now) - Date.parse(record?.successAt || 0) > seconds * this.config.staleMultiplier * 1000;
      return {
        source, label: source === 'machbar' ? 'Machbar' : `Kalender ${Number(source.split(':')[1]) + 1}`,
        state: !record?.data || !covers ? 'unavailable' : record.failed || expired ? 'stale' : 'ok',
        successAt: record?.successAt || null,
      };
    });
    return buildProjection({
      config: this.config, now, health,
      machbar: this.sources.get('machbar')?.data,
      events: this.names().filter((s) => s.startsWith('calendar:')).flatMap((s) => this.sources.get(s)?.data || []),
    });
  }
}
