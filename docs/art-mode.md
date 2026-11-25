# Optional native Art Mode

The Node service works without this worker. Python Playwright renders the same
frontend from one authenticated immutable snapshot at 3840 x 2160, locale
`de-DE`, timezone `Europe/Berlin` by default. No clock/polling/animations,
interactive navigation or fetch-age churn is captured. The week overview and
meaningful event/source-health changes remain. Fonts, images, fallback artwork
and final layout must be ready; failed/auth/loading pages are rejected.

The worker uses `playwright==1.56.0`, `samsungtvws==3.0.7` and Pillow. It compares
semantic fingerprints before rendering and final JPEG SHA256 before publishing,
so changing hidden data cannot cause an identical image to be uploaded again.
Snapshots contain no upstream credentials. Render traffic is same-origin only.

## Render without a TV

Start the demo server as in the README, then:

```sh
npm run worker -- render --at 2026-11-25T10:00:00Z --output artifacts/day.jpg
python scripts/screenshots.py
```

Explicit `--at`/`--variant quiet` are demo-only inputs; production captures the
actual backend snapshot. The screenshot script starts/stops its own loopback
demo server and creates all three documented synthetic layouts.

## Pair and accept passive behavior

For native use, `npm run worker` loads `.env.local` and defaults to loopback,
`data/art-worker` and `data/art-control`. Set `DEMO_MODE=false`,
`ART_MODE_ENABLED=true`, `TV_HOST`, `TV_PORT=8002`, and the same `WORKER_TOKEN`
as the backend. `TV_MATTE=none` is the default. Keep
`TV_SAFE_PROBES_CONFIRMED=false` initially. Direct Python/Compose uses its
documented environment rather than auto-loading a file.

With the TV already on and an operator present:

```sh
npm run worker -- pair
npm run worker -- status
npm run worker -- list
```

Pairing is explicit and persists a protected `pairing.token` outside the image.
Status/capability/list are deliberate operator connections and may disturb
firmware that has not been accepted. Status reports Art API version and matte
capabilities. No background connection is attempted while safe probes remain
unconfirmed. Verify state probes across Art Mode, viewing, sleep and off
before enabling `TV_SAFE_PROBES_CONFIRMED=true`. If they wake/interfere or cannot
reliably distinguish states, leave automatic writes disabled.

## Explicit activation and scheduling

While already in Art Mode:

```sh
npm run worker -- upload --file artifacts/day.jpg --activate
npm run worker -- activate
npm run worker -- run
```

The test upload requires a 3840 x 2160 JPEG. `--activate` deliberately permits
replacing non-service artwork; without it, uploads/selects are deferred until
the current image is positively service-owned. `activate` renders current live
data and requests selection, but **never turns the TV on or enters Art Mode**.
The admin endpoint `/api/art/activate` queues the same one-shot permission.
Pairing/installing is not activation.

Background defaults: evaluate every 60s; at least 300s between uploads, persisted
across restart. Confirmed Art Mode and service-owned current image are required.
Viewing/sleep/off/unpaired/unknown states defer all writes. If the user selects
personal/Art Store artwork, background refresh does not take it back; explicit
activation is required. No WOL, power keys, mode changes, app launches,
brightness or motion/sleep setting changes are issued.

The process journal has a single-writer lock. It records upload intent before
network mutation, persists the returned content ID, rechecks state/current art,
selects, reads current art back, commits success, then cleans only positively
journaled superseded service IDs. Pending/current/unproven/personal/Art Store
images are never cleanup candidates. Selection/upload/cleanup failures retain
the previous good image; known pending uploads are reused after restart.
If viewing or user selection changes during upload, selection is deferred.
The protocol has no atomic compare-state-and-select: the final narrow race
cannot be eliminated in software and must be assessed on the actual firmware.

```sh
npm run worker -- health
npm run worker -- list
npm run worker -- cleanup
# Only after inspecting dry-run IDs:
npm run worker -- cleanup --apply
```

Health checks require a recent successful scheduler heartbeat; normal deferred
states are healthy, repeated failures/unknown upload outcomes are not.
Pairing/list output and the ownership database are private operational data.

## Unknown outcomes and recovery

A lost upload acknowledgment may leave an image on the TV without a known ID.
The worker stops automatic re-upload and reports `recovery_required`; it never
infers ownership from filename or inventory differences. Inspect TV content and
the journal locally. Only with positive independent proof that an ID is this
pending service upload:

```sh
npm run worker -- recover-upload --id <proven-service-content-id> --confirm-owned
```

Resume activation/scheduling afterwards. If ownership cannot be proven, leave
the image quarantined/unmanaged; do not adopt or delete it speculatively.
Preserve the journal and pairing token when upgrading, backing up or restoring.
Use a different state directory for a different TV.

## Physical Frame acceptance (not yet verified)

For the actual QE55LS03DAUXXH/installed firmware, accept pairing persistence,
API version, current/state accuracy, matte support, JPEG dimensions/quality,
upload and read-back-confirmed selection, cleanup and interrupted transactions.
Preserve personal and Art Store images. Exercise restart after known/unknown
upload outcomes and selection acknowledgment loss.

Verify native ambient-light/motion/sleep behavior and energy use remain native.
Test every off/asleep/viewing/HDMI/app state, including transitions during upload
and immediately before selection: no unintended wake, app switch or viewing
interruption. Verify user-selected artwork suspends refresh, explicit activation
is intentional, and pending images publish only when eligible. Firmware source
support and mock tests are not physical compatibility proof. Leave this profile
disabled if any safety gate fails; the live dashboard remains usable.
