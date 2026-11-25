# Operations

## Configuration and trust

Use the [README](../README.md) for Conda and Compose commands. Credentials belong
only in ignored `.env.local` (native) or `.env` (Compose), mode `0600`.
Never commit private hostnames, entity/member IDs, screenshots or projections.
Demo mode ignores live sources and prohibits all TV operations.

The backend speaks HTTP and listens on loopback by default. `AUTH_MODE=token`
needs no PocketID, `PUBLIC_URL` or application certificate. Open
`/display#token=<display-secret>` in the browser or TV; anonymous API access
remains denied, and admin/worker capabilities stay separate. HTTP carries
credentials and household data unencrypted: restrict it to loopback or an
explicitly trusted private network, with no public port-forwarding. Use trusted
HTTPS at a reverse proxy or a VPN when crossing untrusted networks.

`AUTH_MODE=oidc` remains the compatibility default when no mode is set; shipped
examples explicitly select `token`. Token mode disables all OIDC routes and
ignores existing browser session cookies. It does not expose an unauthenticated
fallback or make source credentials available to display clients.

For optional browser login, select `AUTH_MODE=oidc` and terminate trusted HTTPS
on a dedicated origin with a reverse proxy forwarding to port 4321.
Register a separate PocketID confidential authorization-code client, callback
`https://<dashboard-origin>/api/auth/callback`, issuer discovery and client-secret
POST authentication. Authorize the household in PocketID and list exact `sub`
values in `OIDC_ALLOWED_SUBJECTS`. Sessions use 12-hour opaque Secure, HttpOnly,
SameSite cookies; login flows use state, nonce and PKCE. No refresh token or
identity-provider token is stored in the browser. POST `/api/auth/logout`
invalidates the session; browser mutations require the exact dashboard Origin.

Split-horizon DNS is supported; configure real addresses only in local private
files. Containers must resolve/reach their configured source services and trust
their certificates. Do not disable upstream TLS validation. Brightness telemetry
still requires its own trusted HTTPS `PUBLIC_URL`, even in token mode.

The display credential can read `/api/week` and `/api/version`, not render or
administer. The worker credential can read `/api/render-snapshot` and `/render`,
not general household APIs or administration. Admin credentials and authorized
human sessions can inspect health/refresh; explicit TV activation additionally
requires `ART_MODE_ENABLED=true`. All three secrets must differ.

Provision `/display#token=<display-secret>` only on the TV. The fragment is
removed from visible history and exchanged for Bearer headers; the token and
last-good projection live in device-local storage. Treat the TV and WGT as
private devices/artifacts. Rotate `DISPLAY_TOKEN`, restart the server, and
reprovision/repackage after compromise. An online 401/403 purges its cached
projection; a disconnected TV cannot receive revocation until it reconnects.
Rotate worker/admin credentials independently and restart their consumers.
Remove compromised browser subjects and restart the backend to revoke their
authorization; sessions are rechecked against the current subject allowlist.

Presentation settings are in `config.json`, selected by `DASHBOARD_CONFIG`.
Unknown settings are rejected. `EVENING_TRANSITION` and `MAX_VISIBLE_TASKS`
override their JSON values. `TZ` defaults to `Europe/Berlin`; legacy
`DASHBOARD_TZ` is accepted only if it does not conflict. Locale defaults to
`de-DE`. Owner/project/tag filters only narrow authorized household data.
Pack names come from `art/packs/` plus `impressionists` (bundled/offline).

Optional [brightness observation](brightness.md) has its own strict `brightness`
JSON section, disabled by default. It requires non-demo HA reads and a distinct
`BRIGHTNESS_TELEMETRY_TOKEN` for normal-shell status reporting. It has no
TV-setting write path; power, colour, control/restoration and deployment are
separate gates. The one-shot `npm run brightness:observe` needs no content/OIDC
setup, never opens a listener and cannot establish foreground ownership.

## Health and diagnostics

`GET /healthz` is unauthenticated process liveness, not proof of working
integrations. Admin-authenticated `GET /api/health` is readiness: 200 when all
sources are healthy, 503 otherwise. Source failures are independent; warnings
retain last-good contents. Failed or old data is stale; absent/out-of-range
coverage is unavailable. The default age threshold is three polling intervals.

Native commands (load `.env.local`, output may contain household data):

```sh
npm run cli -- calendars
npm run cli -- fetch
npm run cli -- projection
```

These are explicit one-shot fetches; `projection` emits normalized local week,
today, tomorrow and source health, with no upstream credentials. Calendars are
queried by range, not their single next-event state. Range boundaries use local
days, including DST and Sunday's Monday preview. Machbar ordering remains
canonical within overdue/deadline/planned/revisit/completed groups.
With the direct MCP transport, tasks are intentionally limited to today's
canonical commitments and overdue/due-today attention. Tomorrow/week task
lists, revisit-only attention and recap are omitted; calendar views are
unchanged. See [Machbar integration](machbar-integration.md) for credential
scope, unknown availability and midnight/cache behavior.

Admin examples assume credentials have been provisioned in the process
environment (the CLI does not export `.env.local` into your shell):

```sh
curl --fail-with-body -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$PUBLIC_URL/api/refresh"
curl --fail-with-body -H "Authorization: Bearer $ADMIN_TOKEN" "$PUBLIC_URL/api/health"
curl --fail-with-body -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$PUBLIC_URL/api/art/activate"
```

Refresh/activation are rate-limited; source polls coalesce. Activation queues a
single explicit request, expires after one hour, and never wakes the TV.
Do not put credentials in URL queries, shell history literals or shared logs.
An HA `rest_command` can POST that activation URL with its Authorization header
stored in HA secrets. It is an explicit action, not an automatic wake routine.

Logs are JSON with source aliases and sanitized failure codes, never upstream
bodies or credentials. CLI failures intentionally redact third-party exception
text. Check field values, network access, permissions and source health rather
than enabling verbose credential-bearing TV-library logs.

## Persistent state, upgrade and rollback

Native state is under `DATA_DIR` (default `data/`); the worker wrapper uses
`data/art-worker`. Compose volumes are `runtime` (source/art cache and browser
sessions), `control` (activation requests), `artwork` (pairing, render candidates,
SQLite ownership journal). The worker has no Machbar/HA/OIDC credentials and no
access to core sessions; its control volume is read-only.

For the core-only Docker deployment, use `npm run deploy` from the checkout
with Node 24 and `npm ci`. It reads the ignored `.env` and `config.json`,
builds `DASHBOARD_IMAGE`, starts only `dashboard`, and waits for authenticated
source readiness. It supports the Compose v2 plugin and legacy `docker-compose`.
Core-only deployment refuses enabled native-Art operations or brightness
observation; enable those only through their separately accepted runbooks.

The helper records a random ownership identity under `data/deploy/` and labels
only images it builds. After every successful deployment, it deletes every
superseded owned image, keeping only the running image. It never uses global
`prune`, forced image removal or volume deletion, and protects images referenced
by any container, even stopped containers from another project. Such skips are
reported explicitly. Unrelated image-tag/container collisions are rejected,
not adopted or overwritten. Build/start/readiness failures do not prune images.
Keep the ownership state to retain proof across restarts; losing it requires
explicit operator reconciliation, not automatic adoption.

Deployments serialize through `data/deploy/lock`; after a crashed deployment,
confirm no deploy/build is still active before manually removing that empty
stale lock directory. A normal failed/successful run releases its own lock.
The helper replaces only its previously verified owned core container after a
successful build, with a brief restart gap (also avoiding legacy Compose's
incompatibility with recent Docker image metadata). It creates no scheduler
or host-wide cleanup job. Use the helper for upgrades too: raw Docker/Compose
build commands do not execute this retention policy.

Stop both processes/services before backing up. Retain all state, configuration,
secrets and the exact code/image revision together, encrypted and access-limited.
For Compose, `docker compose stop` preserves volumes; snapshot the three named
volumes using your VM's volume-backup tooling. Never use `down --volumes` during
an upgrade. For native use, stop gracefully, then back up `data/` and ignored
configuration with your normal encrypted-backup tooling. SQLite WAL/SHM files
belong to the journal backup too; a clean stop avoids inconsistent copies.

Pin a tested Git revision (or image digest). After backup, update the checkout,
restore dependencies from lockfiles, run the fixture suites, then restart.
Core-only Compose: `npm run deploy`, followed by the optional
`art` profile only if enabled/accepted. Native: `npm ci`, update the optional
Conda/pip environment if manifests changed, then `npm start` and optionally
`npm run worker -- run` under your process supervisor. Do not run two workers
against the same state directory. Graceful shutdown drains in-flight source work.

Check liveness, source readiness and last-good behavior before unattended use.
Rollback means restoring the previous revision/image, its configuration **and
its corresponding stopped-state backup**. A container downgrade alone is not
a state-schema rollback. Never discard the ownership journal: without proof
of ownership, the service must not delete existing TV images. Losing pairing
state requires explicit re-pairing, not a guessed credential.

The core deployment retention policy keeps no old image after success. Rolling
back requires rebuilding the previous Git revision and restoring its matching
configuration/state backup. Shared Docker build caches are not rollback images.

## Verification boundaries

Automated checks exercise fixture APIs, mocked OIDC protocol boundaries,
capability separation, real Chromium rendering, deterministic JPEGs, WGT
structure, interrupted TV transactions and deletion safety. Mocked OIDC is
not a completed PocketID deployment test. Container CI checks images separately
from native Conda execution. Neither proves split-horizon VM DNS, TV trust,
signing identity or Samsung firmware behavior; complete the hardware runbooks.
