# Proposed Machbar read-only display integration

**This is a new API proposal, not an endpoint present in the audited Machbar
deployment.** The dashboard intentionally fails visibly instead of using a
human session cookie, write-capable MCP credential, unauthenticated route or
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
