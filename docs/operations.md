# Operations

## Configuration and trust

Use the [README](../README.md) for Conda and Compose commands. Credentials belong
only in ignored `.env.local` (native) or `.env` (Compose), mode `0600`.
Never commit private hostnames, entity/member IDs, screenshots or projections.
Demo mode ignores live sources and prohibits all TV operations.

The backend listens on loopback by default. Terminate trusted HTTPS on a
dedicated origin with a reverse proxy forwarding to port 4321. PocketID and the
TV must trust its certificate and resolve its hostname on the household LAN.
Split-horizon DNS is supported; configure the operator's real addresses locally.
Do not disable TLS validation. Containers must resolve/reach those same
services; configure the VM's DNS/CA trust if necessary.

Register a separate PocketID confidential authorization-code client, callback
`https://<dashboard-origin>/api/auth/callback`, issuer discovery and client-secret
POST authentication. Authorize the household in PocketID and list exact `sub`
values in `OIDC_ALLOWED_SUBJECTS`. Sessions use 12-hour opaque Secure, HttpOnly,
SameSite cookies; login flows use state, nonce and PKCE. No refresh token or
identity-provider token is stored in the browser. POST `/api/auth/logout`
invalidates the session; browser mutations require the exact dashboard Origin.

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

Stop both processes/services before backing up. Retain all state, configuration,
secrets and the exact code/image revision together, encrypted and access-limited.
For Compose, `docker compose stop` preserves volumes; snapshot the three named
volumes using your VM's volume-backup tooling. Never use `down --volumes` during
an upgrade. For native use, stop gracefully, then back up `data/` and ignored
configuration with your normal encrypted-backup tooling. SQLite WAL/SHM files
belong to the journal backup too; a clean stop avoids inconsistent copies.

Pin a tested Git revision (or image digest). After backup, update the checkout,
restore dependencies from lockfiles, run the fixture suites, then restart.
Compose: `docker compose up -d --build dashboard`, followed by the optional
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

## Verification boundaries

Automated checks exercise fixture APIs, mocked OIDC protocol boundaries,
capability separation, real Chromium rendering, deterministic JPEGs, WGT
structure, interrupted TV transactions and deletion safety. Mocked OIDC is
not a completed PocketID deployment test. Container CI checks images separately
from native Conda execution. Neither proves split-horizon VM DNS, TV trust,
signing identity or Samsung firmware behavior; complete the hardware runbooks.
