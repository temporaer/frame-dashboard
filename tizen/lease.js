(function () {
  'use strict';

  window.createForegroundReporter = function (config) {
    var active = false;
    var stopped = false;
    var session = null;
    var sequence = 0;
    var timer;
    var request;
    var generation = 0;
    var delay = 10000;
    var retry = 5000;

    function schedule(ms) {
      clearTimeout(timer);
      if (active && !stopped) timer = setTimeout(tick, ms);
    }

    function send(body, callback) {
      var current = generation;
      var xhr;
      var done = false;
      function finish(ok) {
        if (done) return;
        done = true;
        if (request === xhr) request = null;
        if (current !== generation) return;
        var result;
        if (ok) {
          try { result = JSON.parse(xhr.responseText); } catch (e) { ok = false; }
        }
        callback(ok, result);
      }
      try {
        xhr = new XMLHttpRequest();
        request = xhr;
        xhr.open('POST', config.endpoint, true);
        xhr.timeout = 5000;
        xhr.withCredentials = false;
        xhr.setRequestHeader('Authorization', 'Bearer ' + config.token);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.onload = function () { finish(xhr.status === 200); };
        xhr.onerror = xhr.ontimeout = function () { finish(false); };
        xhr.send(JSON.stringify(body));
      } catch (e) {
        finish(false);
      }
    }

    function failed() {
      session = null;
      console.warn('frame_foreground_telemetry_unavailable');
      schedule(retry);
      retry = Math.min(60000, retry * 2);
    }

    function tick() {
      if (!config || !active || stopped || request) return;
      if (!session) {
        send({ action: 'challenge' }, function (ok, result) {
          if (!ok || !result || !/^[a-f0-9]{64}$/.test(result.id) ||
              typeof result.heartbeatSeconds !== 'number' || result.heartbeatSeconds < 5 ||
              result.heartbeatSeconds > 30) return failed();
          session = result.id;
          sequence = 0;
          delay = result.heartbeatSeconds * 1000;
          tick();
        });
      } else {
        send({ action: 'report', id: session, sequence: ++sequence }, function (ok, result) {
          if (!ok || !result || result.ok !== true) return failed();
          retry = 5000;
          schedule(delay);
        });
      }
    }

    function release() {
      generation++;
      clearTimeout(timer);
      if (request) {
        request.abort();
        request = null;
      }
      var old = session;
      session = null;
      if (old) send({ action: 'release', id: old, sequence: ++sequence }, function (ok) {
        if (!ok) console.warn('frame_foreground_release_unconfirmed');
        if (active && !stopped) tick();
      });
    }

    return {
      setForeground: function (value) {
        if (!config || stopped || active === value) return;
        active = value;
        if (active) tick();
        else release();
      },
      stop: function () {
        if (!config || stopped) return;
        stopped = true;
        active = false;
        release();
      },
    };
  };
})();
