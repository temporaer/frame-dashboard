import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../tizen/probe.js', import.meta.url), 'utf8');

function run(tizen, webapis) {
  const documentEvents = {};
  const windowEvents = {};
  const timers = new Map();
  const nodes = {
    report: { textContent: '', scrollTop: 0, focus() {} },
    events: { textContent: '' },
  };
  let nextTimer = 0;
  const environment = {
    tizen, webapis,
    innerWidth: 1920, innerHeight: 1080,
    document: {
      visibilityState: 'visible',
      getElementById: (id) => nodes[id],
      addEventListener: (name, callback) => { documentEvents[name] = callback; },
    },
    console: { info() {} },
    setTimeout: (callback) => { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: (id) => timers.delete(id),
    addEventListener: (name, callback) => { windowEvents[name] = callback; },
  };
  environment.window = environment;
  vm.runInNewContext(source, environment, { timeout: 1000 });
  return { environment, documentEvents, windowEvents, nodes, timers };
}

test('probe distinguishes unavailable APIs from negative hardware claims in an ordinary browser', () => {
  const { environment, nodes } = run();
  assert.equal(environment.FRAME_PROBE_REPORT['Merkmal sensor.photometer'].status, 'nicht verfügbar');
  assert.equal(environment.FRAME_PROBE_REPORT['DISPLAY-Auflösung'].status, 'nicht verfügbar');
  assert.equal(environment.FRAME_PROBE_REPORT['tizen.sensorservice.getDefaultSensor'].status, 'nicht vorhanden');
  assert.match(nodes.report.textContent, /keine Aussage zur Hardware/);
  assert.equal(environment.FRAME_PROBE_REPORT['CSS-Viewport'].value, '1920 x 1080');
});

test('probe only reads allowlisted capabilities and display dimensions, never sensors or control methods', () => {
  const calls = [];
  function forbidden() { calls.push('forbidden'); throw new Error('must not be called'); }
  const { environment, timers } = run({
    systeminfo: {
      getCapability(key) { calls.push(key); return key.endsWith('photometer'); },
      getPropertyValue(key, success) {
        calls.push(key);
        success({ resolutionWidth: 3840, resolutionHeight: 2160, brightness: 0.6, extra: 'private' });
      },
    },
    sensorservice: { getAvailableSensors: forbidden, getDefaultSensor: forbidden },
    application: { getCurrentApplication: forbidden, launch: forbidden },
    tvaudiocontrol: { setVolume: forbidden, setMute: forbidden },
    tvdisplaycontrol: { get3DEffectMode: forbidden },
  }, {
    appcommon: { setScreenSaver: forbidden },
    productinfo: { getModelCode: forbidden },
    tvinfo: { getTvInfoValue: forbidden },
  });
  assert.deepEqual(calls, [
    'sensor.photometer', 'sensor.proximity', 'sensor.activity_recognition',
    'sensor.gesture_recognition', 'sensor.accelerometer', 'platform.version', 'profile',
  ].map((key) => 'http://tizen.org/feature/' + key).concat('DISPLAY'));
  assert.equal(environment.FRAME_PROBE_REPORT['Merkmal sensor.photometer'].value, true);
  assert.equal(environment.FRAME_PROBE_REPORT['Merkmal sensor.proximity'].value, false);
  assert.equal(environment.FRAME_PROBE_REPORT['DISPLAY-Auflösung'].value, '3840 x 2160');
  assert.equal(environment.FRAME_PROBE_REPORT['webapis.appcommon.setScreenSaver'].status, 'vorhanden');
  assert.doesNotMatch(JSON.stringify(environment.FRAME_PROBE_REPORT), /private|brightness/);
  assert.equal(timers.size, 0);
});

test('probe surfaces denied getters and malformed responses without leaking error contents', () => {
  const tizen = {
    systeminfo: {
      getCapability(key) {
        if (key.endsWith('photometer')) throw { name: 'SecurityError', message: 'private-address' };
        return null;
      },
      getPropertyValue(key, success) { success({ resolutionWidth: 'wrong' }); },
    },
  };
  Object.defineProperty(tizen, 'sensorservice', {
    get() { throw { name: 'SecurityError', message: 'private-address' }; },
  });
  const { environment } = run(tizen);
  const report = environment.FRAME_PROBE_REPORT;
  assert.equal(report['Merkmal sensor.photometer'].value, 'SecurityError');
  assert.equal(report['Merkmal sensor.proximity'].status, 'Fehler');
  assert.equal(report['tizen.sensorservice.getDefaultSensor'].value, 'SecurityError');
  assert.equal(report['DISPLAY-Auflösung'].status, 'Fehler');
  assert.doesNotMatch(JSON.stringify(report), /private-address/);
});

test('display read times out, ignores late callbacks and reports asynchronous permission errors', () => {
  let success;
  const { environment, timers } = run({
    systeminfo: {
      getPropertyValue(key, callback) { success = callback; },
    },
  });
  assert.equal(environment.FRAME_PROBE_REPORT['DISPLAY-Auflösung'].status, 'ausstehend');
  for (const callback of [...timers.values()]) callback();
  success({ resolutionWidth: 3840, resolutionHeight: 2160 });
  assert.equal(environment.FRAME_PROBE_REPORT['DISPLAY-Auflösung'].value, 'Zeitüberschreitung');
  assert.equal(timers.size, 0);
  const denied = run({
    systeminfo: {
      getPropertyValue(key, callback, error) { error({ name: 'SecurityError', message: 'private' }); },
    },
  });
  assert.equal(denied.environment.FRAME_PROBE_REPORT['DISPLAY-Auflösung'].value, 'SecurityError');
});

test('lifecycle observations are bounded and only explicit Back exits the current app', () => {
  let exits = 0;
  const { environment, documentEvents, windowEvents, nodes } = run({
    application: { getCurrentApplication() { return { exit() { exits++; } }; } },
  });
  environment.document.visibilityState = 'hidden';
  documentEvents.visibilitychange();
  windowEvents.blur();
  windowEvents.pagehide();
  assert.equal(exits, 0);
  assert.match(nodes.events.textContent, /visibility: hidden/);
  for (let i = 0; i < 30; i++) windowEvents.focus();
  assert.equal(environment.FRAME_PROBE_EVENTS.length, 24);
  documentEvents.keydown({ keyCode: 40, preventDefault() {} });
  assert.equal(nodes.report.scrollTop, 140);
  const count = environment.FRAME_PROBE_EVENTS.length;
  documentEvents.keydown({ keyCode: 49 });
  assert.equal(environment.FRAME_PROBE_EVENTS.length, count);
  documentEvents.keydown({ keyCode: 10009, preventDefault() {} });
  assert.equal(exits, 1);
});
