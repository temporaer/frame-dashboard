# Household Frame Dashboard

This fork retains upstream's plain HTML/CSS/ES2019 display, museum placard,
artwork rotation, fonts and thin Tizen shell. It replaces the manually maintained
weekly plan, Vercel functions, Redis, ICS feeds and calendar pushes with one
self-hosted Node service. Machbar owns tasks; Home Assistant owns calendar data.
There is no task editor or independent task database.

The optional `art` Compose profile runs Python Playwright and `samsungtvws`.
It renders the same frontend from an immutable, authenticated projection and
maintains its own durable image-ownership journal. The live service requires
neither Chromium nor Python. Persistent state is a cache, not a source of truth.

Normal browser access requires PocketID and explicit household subject
authorization. A distinct TV token reads ambient information only. Internal
renderer and administration credentials have separate capabilities. Tokens from
upstream services never enter the frontend.

## Audited upstream

Frame Dashboard `8cc81feaca6fd3a14b3d799a83abba512f4ec1ad`:
`public/` is the reusable visual implementation; `lib/week.js` assembled manual
plans and calendars; `lib/art.js` supplies deterministic artwork and attribution.
The original Tizen script required Tizen Studio CLI and SDB. The original tests
passed (16 cases) before replacement.

Machbar `74fc5f04e6fa47e258b39a311710b56b2b0e6529`:
`routes/views.ts` exposes `/api/agenda/today` and `/api/agenda/week`.
`domain/agenda.ts`, `agendaSelection.ts`, `weekAgenda.ts`, `graph.ts` and
`compiledViewProjection.ts` implement ownership, privacy and scheduling.
REST agenda routes require human sessions. Existing MCP credentials can invoke
mutation tools and are not suitable least-privilege display credentials.
See [the separate integration proposal](machbar-integration.md).

## Deliberate policy

Only explicitly scheduled household work and deadline attention are displayed.
Available work, private/work items and arbitrary active-project children are not
commitments. Revisit-only attention and completed-task recap are opt-in. The
evening carries today's unfinished items visually, never reschedules them or
reactivates old missed one-off schedules. Five task rows is the default.

The server polls sources independently, retaining last-good results and exposing
each source's health. Unknown or failed sources are not interpreted as empty.
Time calculations use IANA timezones and local calendar dates, not fixed 24-hour
intervals. Render fingerprints exclude volatile fetch timestamps.

The Art worker never wakes or changes modes automatically. It selects only when
Art Mode is confirmed, verifies selection, and only then deletes positively
journaled superseded service images. An upload with an unknown remote outcome
requires explicit reconciliation rather than a guessed retry or deletion.

## Licensing

Original code remains MIT, fonts retain OFL notices, and artwork retains source
and attribution metadata. Wikipedia-derived facts have separate CC BY-SA
attribution requirements. Unmodified ancillary Mac/Android/launcher projects are
retained for upstream history, not supported as task-writing clients by this
read-only fork. The launcher's third-party notices remain intact.
