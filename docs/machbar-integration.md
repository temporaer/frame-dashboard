# Machbar integration

## Direct MCP: current-day commitments

Set `MACHBAR_MCP_ENDPOINT` to the full trusted HTTPS MCP URL and provision a
separately named **Household** agent token as `MACHBAR_TOKEN`. An explicit
endpoint selects MCP transport unless `MACHBAR_TRANSPORT` is specified; a
contradictory `rest` setting is rejected. Alternatively, select
`MACHBAR_TRANSPORT=mcp` with a `MACHBAR_URL` base URL, resolving `api/mcp`.
`MACHBAR_MCP_TOKEN`, when set, overrides `MACHBAR_TOKEN` for MCP only.
Keep the credential only in the backend's ignored owner-readable
environment file (mode `0600`), never in chat, frontend configuration or the
Tizen package. Existing agent tokens are write-capable; accepting that credential
is a temporary operator choice, not server-enforced read-only authorization.
Revoke it separately when no longer needed. Do not copy HA's OAuth credentials.

The official MCP client connects to `api/mcp` without an LLM. Outbound calls are
restricted to protocol initialization and `machbar_today`, `machbar_get_task`,
`machbar_get_project`. There is no arbitrary tool endpoint, mutation dispatcher,
fallback to REST or automatic token creation. Redirects, subscriptions and
other destinations are refused. Each response is limited to 2 MiB, individual
requests to 15 seconds, the refresh to 30 seconds, and detail reads to 100.
Excessive/malformed results fail explicitly; lists are never silently truncated.

Only the canonical `overdue`, `dueToday` and `planned` task buckets are used,
plus projects in the canonical overdue/due-today buckets. Shared/unscheduled
backlog, future tasks, future project deadlines, next-action suggestions,
revisit-only attention and completed recap are not displayed. Current working
window selection remains Machbar's responsibility. Historical one-off schedules
returned by older MCP servers are excluded rather than revived; the backend
logs only an aggregate exclusion count. Canonical recurring plans are retained.
The audited Today tool uses
the default Europe/Berlin working-window timezone, so this transport currently
requires that dashboard timezone. Optional revisit/recap settings are rejected
in production MCP mode rather than silently ignored.

Each selected item and all its ancestors are checked using detail reads:
scope must be household and privacy ownership must explicitly be null.
Private items/subtrees are omitted; work scope, missing ancestry/metadata,
changed item revisions or failed detail calls fail the refresh closed.
Only normalized display fields are retained; notes, ancestor titles, external
references, member profiles and context details never enter the cache or public
projection. Owner aliases are not supplied by these tools and remain absent.
Existing owner/project/tag filters can only narrow the result.

MCP does not expose combined working-window/context availability. The adapter
retains an explicit unknown value and the display labels it
**Verfügbarkeit ungeprüft**, never pretending that unknown means executable.
Blocked/unexecutable tasks and deadlines retain their attention treatment.

Task data covers only the fetched local day, including in the evening's
separate "Heute noch offen" group. Tomorrow/week task lists remain empty by
design; calendar browsing and tomorrow's appointments are unchanged.
After midnight, yesterday's task snapshot is unavailable and hidden until a
new current-day read succeeds. Same-day failures retain visibly stale last-good
data. Switching transport or MCP token invalidates the source cache.
Demo mode remains fixture-only even with MCP settings present.

This adapter is source-reviewed against Machbar
`74fc5f04e6fa47e258b39a311710b56b2b0e6529` and tested with synthetic MCP responses.
Bounded live read calls also succeeded without displaying or persisting raw
responses. Dashboard deployment and operator acceptance remain separate steps.

## Proposed full-range REST display integration

**This is a new API proposal, not an endpoint present in the audited Machbar
deployment.** `MACHBAR_TRANSPORT=rest` intentionally fails visibly when it is
absent. It never uses a human session cookie, an unauthenticated route or
Machbar's SQLite database. Demo fixtures implement this contract.

Implement and deploy this separately in `temporaer/machbar` before enabling
live task fetching.

Tracked separately: https://github.com/temporaer/machbar/issues/383

## Authentication

Add a revocable, hashed integration credential restricted to `GET` on the
display projection route. Reuse Machbar's established credential management
patterns, but do not grant the credential access to task mutations, human REST
routes, MCP or Home Assistant's write-capable integration protocol. Credential
creation/revocation remains PocketID-authenticated.

## Proposed endpoint

```http
GET /api/integrations/frame-dashboard/projection?start=2026-11-23&end=2026-12-01
Authorization: Bearer <dedicated read-only credential>
```

`start` is inclusive and `end` exclusive; bound the range to 15 local days.
Use the household timezone, return version 1 and an entry for every requested
day (including empty days). The dashboard rejects an incomplete range and a
timezone disagreement.

```json
{
  "version": 1,
  "timeZone": "Europe/Berlin",
  "generatedAt": "2026-11-25T10:00:00Z",
  "days": [{
    "date": "2026-11-25",
    "tasks": [{
      "id": "task:42",
      "title": "Altglas wegbringen",
      "role": "task",
      "parentId": null,
      "projectId": null,
      "scope": "household",
      "privacyOwnerMemberId": null,
      "effectiveOwnerId": null,
      "ownerLabel": null,
      "scheduledDate": "2026-11-25",
      "dueDate": null,
      "revisitAt": null,
      "completedAt": null,
      "reason": "planned",
      "blocked": false,
      "availableNow": true,
      "executable": true,
      "tagIds": []
    }]
  }]
}
```

Task IDs include role to avoid task/project collisions. `parentId` and
`projectId` use the same prefixed format. `reason` is one of `planned`,
`deadline`, `overdue`, `revisit`, `completed`. Return each identity once per
day, with the canonical highest-precedence reason. Do not send notes,
descriptions, external-wait details, intervention journals or private subtrees.
`ownerLabel` is an optional operator-approved compact alias, not a full profile.
`tagIds` contains only stable IDs needed for configured narrowing filters.

## Authoritative semantics

- Reuse `buildAgenda`, `buildWeekAgenda`, `createAgendaSelection` and their graph
  and compiled-view helpers, using explicit household visibility with no private
  viewer. Never return `shared`, `unscheduled` or Week's `unplanned` as promises.
- Honor explicit and inherited ownership, all ancestor privacy/deferral,
  project state, not-before/revisit instants and availability windows.
- A waiting/blocked/deferred deadline is attention, not executable work. A
  historical waiting schedule is not a plan. Revisit is a distinct reason.
- Current-day planned entries obey current execution windows. Future-day
  planned entries describe a valid intended date, not whether the task can be
  executed at the current wall-clock time; retain availability flags.
- Today's unfinished work may be presented beside tomorrow's schedule, but do
  not create new schedules or revive past non-recurring schedules. Keep overdue
  deadline attention. Preserve a distinct project deadline without redundantly
  presenting its children as invented commitments.
- Compute local-day completions in the household timezone, not
  `completedAt.slice(0, 10)`. Use the same timezone for Week's current-date
  boundary. Test Berlin midnight and both DST transitions.
- Reject unexpected methods, invalid/revoked credentials, personal/work scope,
  out-of-range dates and excessive date windows. Add API/auth regression tests.

The dashboard validates this envelope, strips unknown fields, and only narrows
its authorized results. Missing support must remain an explicit unhealthy
source, not silently switch to fixtures.
