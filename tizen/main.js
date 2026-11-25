/* Tizen shell: show the hosted dashboard full screen and keep it awake. */
(function () {
  'use strict';

  var frame = document.getElementById('screen');
  var msg = document.getElementById('msg');
  var ready = false;
  var retry;
  var backoff = 5000;
  var pageVisible = true;
  var lease = window.createForegroundReporter(window.BRIGHTNESS_TELEMETRY);

  function reportForeground() {
    lease.setForeground(ready && pageVisible && !document.hidden && navigator.onLine !== false);
  }

  function screensaverOff() {
    try {
      webapis.appcommon.setScreenSaver(webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_OFF);
    } catch (e) {
      /* Not on a Samsung TV (e.g. the simulator) — nothing to do. */
    }
  }

  function exitApp() {
    lease.stop();
    try {
      tizen.application.getCurrentApplication().exit();
    } catch (e) {
      window.close();
    }
  }

  function show() {
    if (!window.DASHBOARD_URL) {
      msg.textContent = 'Dashboard-Adresse fehlt. Paket mit DASHBOARD_URL neu erstellen.';
      return;
    }
    msg.textContent = '';
    ready = false;
    reportForeground();
    frame.hidden = false;
    frame.src = window.DASHBOARD_URL;
    clearTimeout(retry);
    retry = setTimeout(function () {
      if (!ready && !document.hidden) {
        backoff = Math.min(backoff * 2, 300000);
        show();
      }
    }, backoff);
  }

  // Remote keys go to whichever document has focus; give it to the dashboard
  // so ←/→ browse the week.
  frame.addEventListener('load', function () {
    frame.focus();
  });

  document.addEventListener('keydown', function (e) {
    if (e.keyCode === 10009) exitApp(); // Back / Return
  });

  // Once the dashboard has focus its keys stay inside the iframe, so the
  // page reports Back itself (public/app.js).
  window.addEventListener('message', function (e) {
    if (e.source !== frame.contentWindow || !e.data || e.origin !== new URL(window.DASHBOARD_URL).origin) return;
    if (e.data.type === 'frame-dashboard:ready') {
      ready = true;
      reportForeground();
      backoff = 5000;
      clearTimeout(retry);
    } else if (e.data.type === 'frame-dashboard:back') {
      exitApp();
    }
  });

  // The hosted page refreshes its cached data when its visibility returns.
  document.addEventListener('visibilitychange', function () {
    reportForeground();
    if (!document.hidden) {
      screensaverOff();
      frame.focus();
      if (!ready) show();
    }
  });
  window.addEventListener('pagehide', function () { pageVisible = false; reportForeground(); });
  window.addEventListener('pageshow', function () { pageVisible = true; reportForeground(); });
  window.addEventListener('offline', reportForeground);

  screensaverOff();
  show();
  window.addEventListener('online', function () {
    reportForeground();
    clearTimeout(retry);
    // Keep an already-loaded page: its local cache survives an API outage.
    retry = setTimeout(function () { if (!ready) show(); }, 2000);
  });
})();
