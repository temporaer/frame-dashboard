import { midnight, plusDays, windowFor, datesBetween } from './dates.js';

export function demoSources(now, zone, variant = 'day') {
  const range = windowFor(now, zone);
  const task = (id, title, date, fields = {}) => ({
    id: `task:${id}`, title, role: 'task', parentId: null, projectId: null,
    scope: 'household', privacyOwnerMemberId: null, effectiveOwnerId: null,
    ownerLabel: null, scheduledDate: date, dueDate: null, revisitAt: null,
    completedAt: null, reason: 'planned', blocked: false,
    availableNow: true, executable: true, tagIds: [], ...fields,
  });
  const tomorrow = plusDays(range.today, 1);
  const days = datesBetween(range.start, range.end).map((date) => ({ date, tasks: [] }));
  if (variant !== 'quiet') {
    days.find((d) => d.date === range.today).tasks = [
      task(1, 'Altglas zum Container bringen', range.today),
      task(2, 'Gemüsekiste für Donnerstag bestellen', range.today, { effectiveOwnerId: 1, ownerLabel: 'A' }),
      task(3, 'Rauchmelder im Flur prüfen', null, { dueDate: plusDays(range.today, -1), reason: 'overdue' }),
      task(4, 'Büchereibücher verlängern', null, { dueDate: range.today, reason: 'deadline' }),
      task(5, 'Fahrradlicht reparieren', range.today),
      task(6, 'Pflanzen im Wohnzimmer gießen', range.today),
    ];
    days.find((d) => d.date === tomorrow).tasks = [
      task(7, 'Biotonne an die Straße stellen', tomorrow),
      task(8, 'Zutaten für das gemeinsame Abendessen besorgen', tomorrow),
    ];
  }
  const timed = (date, time) => {
    const [hour, minute] = time.split(':').map(Number);
    // Derive local wall time via the same timezone implementation as the backend.
    return importTime(date, hour, minute, zone);
  };
  const events = variant === 'quiet' ? [] : [
    { id: 'demo:1', date: range.today, title: 'Musikschule', allDay: false, start: timed(range.today, '15:30'), end: timed(range.today, '16:15') },
    { id: 'demo:2', date: range.today, title: 'Gemeinsam kochen', allDay: false, start: timed(range.today, '18:00'), end: timed(range.today, '19:00') },
    { id: 'demo:3', date: tomorrow, title: 'Elternabend', allDay: false, start: timed(tomorrow, '19:30'), end: timed(tomorrow, '21:00') },
    { id: 'demo:4', date: tomorrow, title: 'Büchereitag', allDay: true, start: midnight(tomorrow, zone), end: midnight(plusDays(tomorrow, 1), zone) },
  ];
  return {
    range,
    machbar: { version: 1, timeZone: zone, generatedAt: now, days },
    events,
  };
}

import { Temporal } from '@js-temporal/polyfill';
function importTime(date, hour, minute, zone) {
  return Temporal.PlainDate.from(date).toPlainDateTime({ hour, minute }).toZonedDateTime(zone).toInstant().toString();
}
