# Brightness observation (no control)

The optional brightness observer is **disabled by default** and has no
TV-setting write path. It reads configured Home Assistant entity states,
calculates a provisional backlight candidate and explains blocking conditions.
It does not set/restore backlight, call HA services (including `update_entity`),
install scripts/helpers, wake/sleep the TV, control presence, select Art Mode,
or change colour, AI or picture mode. The optional native Art worker is separate.

Nothing here has been deployed or accepted as an automatic controller on a TV.
Enabling observation never authorizes or implements live adjustment.

## Private configuration

Copy the `brightness` section from
[`config.brightness.example.json`](../config.brightness.example.json) into your
ignored dashboard JSON, preserving existing presentation settings. Its entity
names, age thresholds and curve are **synthetic examples, not calibration**.
Choose your couch/room lux sensor, the **normal-viewing physical backlight**
number and the matching TV media player; do not substitute black level or
Art-specific brightness. The observer currently validates the tested native
range 0..50, step 1. Different metadata is explicitly blocked.

After separately approving live reads, set `enabled: true`. Supply `HA_URL`,
`HA_TOKEN` and `DEMO_MODE=false`. The normal server still requires its usual
production Machbar, authentication and calendar configuration (PocketID is
optional with token mode). Brightness telemetry additionally requires a trusted
HTTPS `PUBLIC_URL`. Demo cannot enable
live observation, even if HA credentials happen to be present.

For the normal server, generate a new `BRIGHTNESS_TELEMETRY_TOKEN` with
`openssl rand -hex 32`. It must differ from display, worker, admin and upstream
credentials. Keep secrets in ignored owner-only environment files, not JSON.
The existing Compose `env_file` passes this setting without additional services.
An enabled backend observer starts with the existing server and shuts down with
it. Disabled mode creates no HA traffic or observer timer.

Unknown keys, reversed/out-of-range limits, nonmonotonic curves, missing enabled
entity/freshness settings and contradictory lease intervals fail validation.
Omit `curve` to get `curve_not_configured` rather than an invented candidate.
An optional `night` object accepts local `start`/`end` (`HH:mm`) and integer
`max` inside the configured bounds, using `TZ`/`DASHBOARD_TZ`, Berlin by default.
It is a diagnostic cap, not an instruction to the TV.

## Observe once without content deployment

The explicit native command loads `.env.local` but needs only the configured
brightness section, non-demo HA connection and optional timezone:

```sh
npm run brightness:observe
```

It reads only the three configured entity states and exits. It does not open a
server, require a telemetry secret, or require Machbar/PocketID/calendar setup.
It always reports `foreground_lease_missing`; it cannot establish ownership.
Connection/contract errors produce a sanitized error and nonzero exit.
Valid readings may still have blocking reasons. Treat numeric output as
private household information; do not publish or commit it.

## Normal-shell foreground lease

This requires a working, trusted HTTPS dashboard origin and a separately
approved normal-shell installation. The existing offline probe never reports a
lease and its package contains no telemetry code or credential.

In the ignored packaging environment, explicitly set
`TIZEN_BRIGHTNESS_TELEMETRY_TOKEN` to the backend's telemetry secret, then run
`npm run tizen:build`. Leave that variable **unset**, not empty, for no telemetry.
The normal WGT contains the display credential and, only when provisioned, the
separate telemetry credential. Keep it private (mode `0600`). Both stay out of
query strings; the telemetry credential never enters the iframe address.
Signing/installing/launching remain separate operator actions. Stable app and
author identity must be preserved; installing replaces the diagnostic variant.

The shell sends to `/api/brightness/lease` only while visible, online and after
the expected iframe has reported ready. Focusing the iframe is normal and does
not revoke the lease. Hidden/pagehide/offline/Back stops local reporting and
attempts a bounded release; Back does not wait for networking. The server
expires missed reports (default 30 seconds; heartbeat 10 seconds).

Challenges are backend-issued, expire on a monotonic clock and supersede the
previous session. Reports carry increasing sequences; expired/replayed reports
cannot revive a lease. Backend restart loses all leases. Reconnection may resume
observation, but can never arm control because no control exists.

Only the telemetry credential can use this JSON POST endpoint; display,
worker, admin and cookie roles cannot report a lease. It grants no data,
status, render or administration access. Request size/rate/deadline limits
apply. CORS is restricted to this route, supports the packaged shell's `null`
origin and the configured dashboard origin, never allows credentials/cookies
and does not relax other API origins. A bearer secret is still required:
the `null` Origin is not authentication. Actual Tizen origin/visibility and
network-failure behavior require on-device acceptance.

## Inspect diagnostics

Use an authorized browser session or admin bearer token:

```sh
curl --fail-with-body -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$PUBLIC_URL/api/brightness/status"
```

The response is always `mode: "observe"`, `writes_supported: false`. Enabled
status includes raw/smoothed lux, current/candidate backlight, report/change and
observation ages, foreground-lease state, eligibility, reasons and a diagnostic
decision: `blocked`, `within_deadband`, `minimum_interval` or `would_change`.
`would_change` is a calculation only, never a service call or hardware success.
No telemetry secret/session ID or entity identifiers appear in status.
Public health and display/render projections contain none of this information.

Candidate calculation interpolates monotonic points in `log1p(lux)`, applies
time-based exponential smoothing, then native integer limits and optional night
cap. Re-reading status does not apply smoothing again to the same observation.
Lost inputs and restart reset smoothing. The minimum interval counts from the
first observed/current-backlight change, not from an imaginary sent command.
These are provisional diagnostics, not calibrated luminance/energy estimates.

Polling is coalesced, defaults to 30 seconds and backs off up to five minutes.
Each of the three GETs has a five-second deadline, bounded responses and no
redirect following. Errors discard the current sample, clear temporal state
and surface a sanitized warning/status error; no offline write is queued.
No continuous sensor history, occupancy data or lease is persisted.

## Freshness and later control gates

Fetching HA state successfully only proves HA answered. It is not a forced
physical getter and does not prove that cached app/backlight state is current.
`last_changed` is diagnostic, not liveness; unchanged values can be legitimate.
The observer requires `last_reported` within explicitly configured limits.
Missing, future or old report timestamps block eligibility. HA report freshness
is still not independent proof of device-level polling: verify the integration
on the actual firmware before considering any write implementation.

Eligibility additionally requires TV on, exact dashboard `app_id`, explicit
Art-off evidence and the fresh shell lease. Missing/conflicting evidence blocks;
generic power/source values are not ownership. Separate HA reads are not atomic.
The lease is authenticated software telemetry, not hardware attestation.

Before any later control milestone: accept lease/HA state behavior on hardware;
approve a real brightness curve; design execution-time HA guards, serialization,
durable original capture/intent, getter-confirmed effects, manual-override
handling and safe restoration. Lost ownership must never cause delayed writes
into unrelated viewing. Sleep/absence, power and colour remain out of scope.
