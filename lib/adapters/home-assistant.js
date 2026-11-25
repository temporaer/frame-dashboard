import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Temporal } from '@js-temporal/polyfill';
import { datesBetween, midnight, plusDays } from '../dates.js';
import { endpoint, fetchJson } from '../request.js';
import { localDate } from './machbar.js';

const boundary = z.union([
  z.string(),
  z.object({ date: localDate }),
  z.object({ dateTime: z.string() }),
]);
const eventSchema = z.object({
  start: boundary, end: boundary,
  summary: z.string().max(2000).optional(),
  uid: z.string().optional(), recurrence_id: z.string().nullable().optional(),
});

function value(bound) {
  return typeof bound === 'string' ? bound : bound.date ?? bound.dateTime;
}

export function parseCalendar(raw, entity, range, zone) {
  const events = z.array(eventSchema).max(10000).parse(raw);
  const dates = datesBetween(range.start, range.end);
  return events.flatMap((e) => {
    const start = value(e.start);
    const end = value(e.end);
    const allDay = localDate.safeParse(start).success;
    if (allDay !== localDate.safeParse(end).success) throw new Error('calendar_boundary_type_mismatch');
    const a = allDay ? midnight(start, zone) : Temporal.Instant.from(start).toString();
    const b = allDay ? midnight(end, zone) : Temporal.Instant.from(end).toString();
    if (Temporal.Instant.compare(a, b) >= 0) throw new Error('calendar_invalid_interval');
    const title = e.summary?.trim() || 'Termin';
    const identity = createHash('sha256').update(JSON.stringify([entity, e.uid || title, e.recurrence_id, start, end])).digest('hex').slice(0, 24);
    return dates.filter((date) =>
      Temporal.Instant.compare(a, midnight(plusDays(date, 1), zone)) < 0 &&
      Temporal.Instant.compare(b, midnight(date, zone)) > 0,
    ).map((date) => ({
      id: `${identity}:${date}`, date, title, allDay,
      start: a, end: b,
      continuesBefore: Temporal.Instant.compare(a, midnight(date, zone)) < 0,
      continuesAfter: Temporal.Instant.compare(b, midnight(plusDays(date, 1), zone)) > 0,
    }));
  });
}

export async function fetchCalendar(config, entity, range, fetcher) {
  const url = endpoint(config.haUrl, `api/calendars/${encodeURIComponent(entity)}`);
  url.searchParams.set('start', midnight(range.start, config.zone));
  url.searchParams.set('end', midnight(range.end, config.zone));
  return parseCalendar(await fetchJson(url, config.haToken, fetcher), entity, range, config.zone);
}

export async function discoverCalendars(config, fetcher) {
  return z.array(z.object({ entity_id: z.string(), name: z.string() }))
    .parse(await fetchJson(endpoint(config.haUrl, 'api/calendars'), config.haToken, fetcher));
}
