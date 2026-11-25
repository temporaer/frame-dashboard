import { Temporal } from '@js-temporal/polyfill';

export function dateAt(instant, zone) {
  return Temporal.Instant.from(instant).toZonedDateTimeISO(zone).toPlainDate().toString();
}

export function plusDays(date, count) {
  return Temporal.PlainDate.from(date).add({ days: count }).toString();
}

export function monday(date) {
  const d = Temporal.PlainDate.from(date);
  return d.subtract({ days: d.dayOfWeek - 1 }).toString();
}

export function datesBetween(start, end) {
  const days = [];
  for (let d = start; d < end; d = plusDays(d, 1)) {
    if (days.length >= 15) throw new Error('date_range_excessive');
    days.push(d);
  }
  if (!days.length) throw new Error('date_range_empty');
  return days;
}

export function midnight(date, zone) {
  return Temporal.PlainDate.from(date).toZonedDateTime(zone).toInstant().toString();
}

export function displayPhase(instant, zone, evening) {
  const local = Temporal.Instant.from(instant).toZonedDateTimeISO(zone);
  const boundary = local.toPlainDate().toPlainDateTime(evening)
    .toZonedDateTime(zone, { disambiguation: 'compatible' });
  const isEvening = Temporal.ZonedDateTime.compare(local, boundary) >= 0;
  return { evening: isEvening, night: isEvening || local.hour < 6 };
}

export function windowFor(instant, zone) {
  const today = dateAt(instant, zone);
  const start = monday(today);
  return { start, end: plusDays(start, 8), today };
}
