(function () {
  'use strict';

  var reportNode = document.getElementById('report');
  var eventsNode = document.getElementById('events');
  var report = {};
  var events = [];
  window.FRAME_PROBE_REPORT = report;
  window.FRAME_PROBE_EVENTS = events;

  function errorName(error) {
    var name = error && error.name;
    return ['SecurityError', 'NotSupportedError', 'UnknownError', 'TypeMismatchError',
      'InvalidValuesError', 'NotFoundError', 'TypeError'].indexOf(name) >= 0 ? name : 'Error';
  }

  function record(label, status, value) {
    report[label] = { status: status, value: value };
    reportNode.textContent = Object.keys(report).map(function (key) {
      var item = report[key];
      return key + ': ' + item.status + ' / ' + JSON.stringify(item.value);
    }).join('\n');
    console.info('FRAME_PROBE_REPORT', JSON.stringify(report));
  }

  function event(name) {
    events.push(new Date().toISOString() + ' ' + name);
    if (events.length > 24) events.shift();
    eventsNode.textContent = events.join('\n');
    console.info('FRAME_PROBE_EVENT', events[events.length - 1]);
  }

  function lookup(path) {
    return path.split('.').reduce(function (value, key) {
      return value == null ? undefined : value[key];
    }, window);
  }

  function method(path) {
    try {
      record(path, typeof lookup(path) === 'function' ? 'vorhanden' : 'nicht vorhanden', 'nur Existenzprüfung');
    } catch (error) {
      record(path, 'Fehler', errorName(error));
    }
  }

  function capability(key) {
    var label = 'Merkmal ' + key;
    try {
      var systeminfo = lookup('tizen.systeminfo');
      if (!systeminfo || typeof systeminfo.getCapability !== 'function') {
        record(label, 'nicht verfügbar', 'keine Aussage zur Hardware');
        return;
      }
      var value = systeminfo.getCapability('http://tizen.org/feature/' + key);
      if (typeof value !== 'boolean' && typeof value !== 'string' && typeof value !== 'number') {
        record(label, 'Fehler', 'ungültige Antwort');
        return;
      }
      record(label, 'gemeldet', typeof value === 'string' ? value.slice(0, 80) : value);
    } catch (error) {
      record(label, 'Fehler', errorName(error));
    }
  }

  [
    'sensor.photometer', 'sensor.proximity', 'sensor.activity_recognition',
    'sensor.gesture_recognition', 'sensor.accelerometer',
    'platform.version', 'profile'
  ].forEach(capability);

  [
    'tizen.systeminfo.getPropertyValue',
    'tizen.sensorservice.getAvailableSensors',
    'tizen.sensorservice.getDefaultSensor',
    'tizen.application.getCurrentApplication',
    'tizen.application.launch',
    'tizen.tvaudiocontrol.setVolume',
    'tizen.tvaudiocontrol.setMute',
    'tizen.tvdisplaycontrol.get3DEffectMode',
    'webapis.appcommon.setScreenSaver',
    'webapis.productinfo.getModelCode',
    'webapis.tvinfo.getTvInfoValue'
  ].forEach(method);

  function viewport() {
    record('CSS-Viewport', 'beobachtet', window.innerWidth + ' x ' + window.innerHeight);
  }

  function display() {
    var settled = false;
    var timer;
    function finish(status, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      record('DISPLAY-Auflösung', status, value);
    }
    try {
      var systeminfo = lookup('tizen.systeminfo');
      if (!systeminfo || typeof systeminfo.getPropertyValue !== 'function') {
        finish('nicht verfügbar', 'keine Aussage zur Hardware');
        return;
      }
      record('DISPLAY-Auflösung', 'ausstehend', 'maximal 3 Sekunden');
      timer = setTimeout(function () { finish('Fehler', 'Zeitüberschreitung'); }, 3000);
      systeminfo.getPropertyValue('DISPLAY', function (value) {
        if (!value || typeof value.resolutionWidth !== 'number' || typeof value.resolutionHeight !== 'number') {
          finish('Fehler', 'ungültige Antwort');
          return;
        }
        finish('gemeldet', value.resolutionWidth + ' x ' + value.resolutionHeight);
      }, function (error) {
        finish('Fehler', errorName(error));
      });
    } catch (error) {
      finish('Fehler', errorName(error));
    }
  }

  document.addEventListener('visibilitychange', function () {
    event('visibility: ' + document.visibilityState);
  });
  ['focus', 'blur', 'pageshow', 'pagehide'].forEach(function (name) {
    window.addEventListener(name, function () { event(name); });
  });
  window.addEventListener('resize', viewport);
  document.addEventListener('keydown', function (key) {
    if ([13, 37, 38, 39, 40, 10009].indexOf(key.keyCode) < 0) return;
    event('Taste: ' + key.keyCode);
    if (key.keyCode === 38 || key.keyCode === 40) {
      key.preventDefault();
      reportNode.scrollTop += key.keyCode === 38 ? -140 : 140;
    }
    if (key.keyCode === 10009) {
      key.preventDefault();
      try {
        window.tizen.application.getCurrentApplication().exit();
      } catch (error) {
        event('Beenden fehlgeschlagen: ' + errorName(error));
      }
    }
  });

  viewport();
  display();
  event('Start: visibility=' + document.visibilityState);
  reportNode.focus();
})();
