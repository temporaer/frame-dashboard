# Tizen shell

The shell keeps one stable fork identity: package `FrameHs001`, application
`FrameHs001.Dashboard`, display name `Haushaltsgalerie`. It coexists with upstream.
Future updates must preserve this identity and the existing author certificate.
Only the thin iframe shell is installed; hosted frontend updates need no WGT
reinstall. Back exits normally, with no assumed custom launcher.

## Build on Linux

Node 24 and Python 3 suffice; no Tizen Studio, SDB or ARM cross-compiler:

```sh
# Set the private DASHBOARD_URL in ignored .env.local:
# https://<trusted-dashboard-origin>/display#token=<display-secret>
npm run tizen:build
```

Output: `tizen/HouseholdFrame.unsigned.wgt`, reproducible ZIP with only widget
config, shell, icon and generated dashboard URL. Its file mode is `0600`;
**it contains the display credential**. Do not upload it as a public artifact.
Access is restricted to that origin. Deploy trusted HTTPS, not a public HTTP
listener. The package builder permits HTTP for isolated packaging tests only.

The iframe accepts a ready message only from its configured origin/window.
Failed initial connections retry with capped exponential backoff; the frontend
retains last-good data across ordinary source/network failures, purges it after
authorization failure, and detects hosted build changes. There is no periodic
full iframe reload. Left/right and OK retain upstream week navigation.

## Offline read-only capability probe

```sh
npm run tizen:probe
```

Produces `tizen/HouseholdFrame.probe.unsigned.wgt` without reading `.env.local`,
requiring a backend or including a display credential. Nothing is signed,
installed or launched by this command. **It uses the same package/application
identity as the dashboard**, so installing it replaces that shell, not a second
app. Restore the normal shell with the same author certificate when finished;
do not uninstall or change IDs. Signing/install/launch require separate consent,
and launch leaves native Art Mode.

The probe contains no hosted iframe, internet privilege or network access rule;
CSP blocks network connections. Unlike the normal shell it does not disable the
screensaver. Its only automatic native calls are `systeminfo.getCapability` for
an explicit sensor/platform allowlist and one bounded `getPropertyValue('DISPLAY')`
read, retaining only resolution. Other API methods are inspected for presence,
never invoked. It does not activate sensors, read camera/microphone data, request
permissions, enumerate other apps or read identifiers/network addresses.
Back explicitly exits its own app.

The German screen shows advertised light/proximity/activity/gesture/motion
features, candidate API method availability, viewport/display resolution and
a bounded in-memory log of visibility/focus/page/remote events. Up/down scrolls
the capability report. The same sanitized data is available as
`FRAME_PROBE_REPORT` and `FRAME_PROBE_EVENTS` in Web Inspector and is written to
the app console, not sent to a server or persisted by the probe.

A `true` feature flag is not a sensor measurement or permission guarantee;
`false`, missing APIs and `SecurityError` are separate outcomes, not proof that
the physical Frame sensor is absent. Existing control methods are **untested**,
and visibility/focus alone cannot establish foreground ownership. No power,
Art Mode, backlight or colour-temperature control is exercised or inferred.
Compare lifecycle behavior both with and without a debugger.

Feature keys follow Samsung's [SystemInfo capability reference](https://developer.samsung.com/smarttv/develop/api-references/tizen-web-device-api-references/systeminfo-api/getting-device-capabilities-using-systeminfo-api.html).
The generic `sensorservice` namespace is checked only if exposed; it is not
assumed to be part of the TV profile. On one tested Tizen 9.0 Frame, the probe
installed/launched successfully and the operator confirmed `sensor.photometer`
and `sensor.proximity` both reported `false`. That is an app-context capability
result, not proof that the physical sensors do not exist. Other readings and
foreground/lifecycle behavior still require on-device verification.

## Existing Samsung certificates and Apps2Samsung

Install the operator's Apps2Samsung CLI according to its project documentation.
Stable v3.3.1 source was reviewed for the commands below; installed 3.3.3-beta
help was also checked. The offline probe was signed using an existing Samsung
Partner certificate via `sign --duids`, installed through direct SDB, and
physically confirmed running. The normal hosted shell is not yet accepted.
First inspect the installed help/version and existing certificate store. Reuse
or import the established Samsung author/distributor material through that
version's documented flow; verify the TV DUID is covered. Do not generate a
replacement author identity or force login merely to make an update succeed.

**Shared-host caution:** the inspected Apps2Samsung 3.3.3-beta TV-connection
wrapper stops competing SDB servers automatically. Do not run its TV-connection
commands on a shared host without accounting for that side effect. This project's
probe used bounded direct SDB operations instead; that temporary diagnostic
transport is not a production dependency.

An offline signing form verified with the installed version is below. Obtain
the target DUID privately and verify that the existing selected certificate
covers it before running; the CLI otherwise offers certificate provisioning.
`--partner` selects the already-established Partner profile used for this probe,
not an extra privilege requested by the app.

```sh
apps2samsung-cli sign tizen/HouseholdFrame.probe.unsigned.wgt \
  -o tizen/HouseholdFrame.probe.wgt --duids "$TV_DUID" --samsung-cert --partner
```

For an appropriate isolated operator environment, with the TV already on,
Developer Mode/installation authorization configured, and `TV_HOST` exported,
the source/help-verified normal-shell flow is:

```sh
apps2samsung-cli --help
apps2samsung-cli cert --tv "$TV_HOST"
apps2samsung-cli sign tizen/HouseholdFrame.unsigned.wgt -o tizen/HouseholdFrame.wgt --tv "$TV_HOST" --samsung-cert
apps2samsung-cli install tizen/HouseholdFrame.wgt --tv "$TV_HOST" --samsung-cert
# Separate, deliberate launch:
apps2samsung-cli launch FrameHs001.Dashboard --tv "$TV_HOST"
```

`npm run tizen:install` wraps sign/install only; unlike build it expects an
already exported `TV_HOST`. Do not use `--new-id`, uninstall, force login or
implicit launch. Keep signed WGT and certificates private. Launching the live
app and using native Art Mode are different operating modes.

## On-device acceptance

Verify coexistence with upstream; update-in-place with unchanged signing
identity; real viewport/font/TLS rendering; readable German/long titles and
artwork credits; all remote keys/Back; foreground/resume; initial offline
launch and recovery; cached network outage vs revoked token; hosted build
update without reinstall. The web app is not native Art Mode and cannot claim
its ambient-light, motion, sleep or energy behavior.
