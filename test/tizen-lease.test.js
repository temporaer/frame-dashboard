import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../tizen/lease.js', import.meta.url), 'utf8');
const main = await fs.readFile(new URL('../tizen/main.js', import.meta.url), 'utf8');

function reporter(config = { endpoint: 'https://frame.example/api/brightness/lease', token: 'private-telemetry' }) {
  const timers = new Map();
  const calls = [];
  const warnings = [];
  let next = 0;
  const environment = {
    console: { warn: (code) => warnings.push(code) },
    setTimeout: (callback, ms) => { timers.set(++next, { callback, ms }); return next; },
    clearTimeout: (id) => timers.delete(id),
    XMLHttpRequest: class {
      constructor() { calls.push(this); this.headers = {}; }
      open(method, url) { this.method = method; this.url = url; }
      setRequestHeader(key, value) { this.headers[key] = value; }
      send(body) { this.body = JSON.parse(body); }
      abort() { this.aborted = true; }
      respond(body, code = 200) { this.responseText = JSON.stringify(body); this.status = code; this.onload(); }
    },
  };
  environment.window = environment;
  vm.runInNewContext(source, environment);
  const lease = environment.createForegroundReporter(config);
  const advance = () => {
    const [id, timer] = timers.entries().next().value;
    timers.delete(id);
    timer.callback();
  };
  return { lease, calls, timers, warnings, environment, advance };
}
const challenge = { id: 'a'.repeat(64), heartbeatSeconds: 10 };

test('shell lease is opt-in and serializes challenge/heartbeat with no iframe credential', () => {
  const disabled = reporter(null);
  disabled.lease.setForeground(true);
  assert.equal(disabled.calls.length, 0);
  const fixture = reporter();
  fixture.lease.setForeground(true);
  const request = fixture.calls[0];
  assert.equal(request.method, 'POST');
  assert.equal(request.url, 'https://frame.example/api/brightness/lease');
  assert.equal(request.withCredentials, false);
  assert.equal(request.timeout, 5000);
  assert.equal(request.headers.Authorization, 'Bearer private-telemetry');
  assert.equal(request.body.action, 'challenge');
  fixture.lease.setForeground(true);
  assert.equal(fixture.calls.length, 1);
  request.respond(challenge);
  assert.equal(fixture.calls[1].body.sequence, 1);
  fixture.calls[1].respond({ ok: true });
  fixture.advance();
  assert.equal(fixture.calls[2].body.sequence, 2);
  fixture.calls[2].respond({ ok: true });
  fixture.lease.setForeground(false);
  assert.equal(fixture.calls[3].body.action, 'release');
  assert.equal(fixture.calls[3].body.sequence, 3);
  assert.equal(fixture.timers.size, 0);
});

test('hidden/Back aborts in-flight reports and ignores late responses; resume waits for bounded release', () => {
  const fixture = reporter();
  fixture.lease.setForeground(true);
  const old = fixture.calls[0];
  fixture.lease.setForeground(false);
  assert.equal(old.aborted, true);
  old.respond(challenge);
  assert.equal(fixture.calls.length, 1);
  fixture.lease.setForeground(true);
  fixture.calls[1].respond(challenge);
  const report = fixture.calls[2];
  fixture.lease.setForeground(false);
  assert.equal(report.aborted, true);
  assert.equal(fixture.calls[3].body.action, 'release');
  fixture.lease.setForeground(true);
  assert.equal(fixture.calls.length, 4);
  fixture.calls[3].respond({ ok: true });
  assert.equal(fixture.calls[4].body.action, 'challenge');
  fixture.lease.stop();
  assert.equal(fixture.calls[4].aborted, true);
  fixture.lease.setForeground(true);
  assert.equal(fixture.calls.length, 5);
});

test('network/expired challenge failures use bounded retries and surface only sanitized errors', () => {
  const fixture = reporter();
  fixture.lease.setForeground(true);
  fixture.calls[0].ontimeout();
  assert.deepEqual(fixture.warnings, ['frame_foreground_telemetry_unavailable']);
  assert.equal([...fixture.timers.values()][0].ms, 5000);
  fixture.advance();
  fixture.calls[1].respond(challenge);
  fixture.calls[2].respond({ error: 'private-upstream-body' }, 409);
  assert.equal([...fixture.timers.values()][0].ms, 10000);
  assert.doesNotMatch(JSON.stringify(fixture.warnings), /private-upstream-body|private-telemetry/);
  fixture.lease.setForeground(false);
  assert.equal(fixture.timers.size, 0);
  const broken = reporter();
  broken.environment.XMLHttpRequest = class { constructor() { throw new Error('platform denied private-host'); } };
  assert.doesNotThrow(() => broken.lease.setForeground(true));
  assert.doesNotThrow(() => broken.lease.stop());
  assert.deepEqual(broken.warnings, ['frame_foreground_telemetry_unavailable']);
});

function shell() {
  const events = {};
  const documentEvents = {};
  const foreground = [];
  const timers = new Map();
  let next = 0;
  let exits = 0;
  let stops = 0;
  const frame = {
    contentWindow: {}, hidden: true, addEventListener() {}, focus() {},
  };
  const environment = {
    DASHBOARD_URL: `https://frame.example/display#token=${'d'.repeat(32)}`,
    BRIGHTNESS_TELEMETRY: { token: 'not-for-iframe' },
    createForegroundReporter: () => ({ setForeground: (state) => foreground.push(state), stop: () => stops++ }),
    document: {
      hidden: false,
      getElementById: (name) => name === 'screen' ? frame : { textContent: '' },
      addEventListener: (name, callback) => { documentEvents[name] = callback; },
    },
    navigator: { onLine: true }, URL,
    addEventListener: (name, callback) => { events[name] = callback; },
    setTimeout: (callback) => { timers.set(++next, callback); return next; },
    clearTimeout: (id) => timers.delete(id),
    tizen: { application: { getCurrentApplication: () => ({ exit: () => exits++ }) } },
    webapis: { appcommon: { setScreenSaver() {}, AppCommonScreenSaverState: { SCREEN_SAVER_OFF: 0 } } },
  };
  environment.window = environment;
  vm.runInNewContext(main, environment);
  const message = (type, origin = 'https://frame.example') => events.message({ source: frame.contentWindow, origin, data: { type } });
  return { environment, documentEvents, events, foreground, frame, message, exits: () => exits, stops: () => stops };
}

test('normal shell requires its ready iframe and visibility, not top-level focus; hides/offline revoke and Back exits', () => {
  const fixture = shell();
  assert.equal(fixture.foreground.at(-1), false);
  fixture.message('frame-dashboard:ready', 'https://other.example');
  assert.equal(fixture.foreground.at(-1), false);
  fixture.message('frame-dashboard:ready');
  assert.equal(fixture.foreground.at(-1), true);
  assert.doesNotMatch(fixture.frame.src, /not-for-iframe/);
  fixture.environment.document.hidden = true;
  fixture.documentEvents.visibilitychange();
  assert.equal(fixture.foreground.at(-1), false);
  fixture.environment.document.hidden = false;
  fixture.documentEvents.visibilitychange();
  assert.equal(fixture.foreground.at(-1), true);
  fixture.events.pagehide();
  assert.equal(fixture.foreground.at(-1), false);
  fixture.events.pageshow();
  assert.equal(fixture.foreground.at(-1), true);
  fixture.environment.navigator.onLine = false;
  fixture.events.offline();
  assert.equal(fixture.foreground.at(-1), false);
  fixture.message('frame-dashboard:back');
  assert.equal(fixture.stops(), 1);
  assert.equal(fixture.exits(), 1);
  const direct = shell();
  direct.documentEvents.keydown({ keyCode: 10009 });
  assert.equal(direct.stops(), 1);
  assert.equal(direct.exits(), 1);
});
