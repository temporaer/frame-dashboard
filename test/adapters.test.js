import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCalendar, fetchCalendar } from '../lib/adapters/home-assistant.js';
import { parseMachbar } from '../lib/adapters/machbar.js';
import { demoSources } from '../lib/demo.js';
import { midnight, displayPhase } from '../lib/dates.js';

const zone = 'Europe/Berlin';
const range = { start: '2026-03-28', end: '2026-03-31' };

test('calendar uses overlap and exclusive all-day ends through spring DST', () => {
  const parsed = parseCalendar([
    { summary: 'Besuch', start: { date: '2026-03-28' }, end: { date: '2026-03-30' }, description: 'private' },
    { summary: 'Nachtzug', start: '2026-03-28T22:30:00Z', end: '2026-03-29T02:30:00Z', location: 'private' },
    { summary: 'Frühstück', start: { dateTime: '2026-03-29T08:00:00+02:00' }, end: { dateTime: '2026-03-29T09:00:00+02:00' } },
  ], 'calendar.example', range, zone);
  assert.deepEqual(parsed.filter((e) => e.allDay).map((e) => e.date), ['2026-03-28', '2026-03-29']);
  const train = parsed.filter((e) => e.title === 'Nachtzug');
  assert.equal(train.length, 2);
  assert.equal(train[0].continuesAfter, true);
  assert.equal(train[1].continuesBefore, true);
  assert.ok(parsed.every((e) => !('description' in e) && !('location' in e)));
  assert.equal(Date.parse(midnight('2026-03-30', zone)) - Date.parse(midnight('2026-03-29', zone)), 23 * 3600000);
});

test('calendar preserves overlapping recurrence instances and autumn repeated hours', () => {
  const raw = [
    { uid: 'recurring', summary: 'Termin', start: '2026-10-25T02:15:00+02:00', end: '2026-10-25T02:45:00+02:00' },
    { uid: 'recurring', summary: 'Termin', start: '2026-10-25T02:15:00+01:00', end: '2026-10-25T02:45:00+01:00' },
  ];
  const parsed = parseCalendar(raw, 'calendar.example', { start: '2026-10-25', end: '2026-10-26' }, zone);
  assert.equal(parsed.length, 2);
  assert.notEqual(parsed[0].id, parsed[1].id);
  assert.equal(Date.parse(midnight('2026-10-26', zone)) - Date.parse(midnight('2026-10-25', zone)), 25 * 3600000);
  assert.throws(() => parseCalendar([{ start: '2026-10-25', end: '2026-10-24' }], 'calendar.example', range, zone));
});

test('calendar fetch uses range API and keeps bearer credentials out of URL', async () => {
  await fetchCalendar({ zone, haUrl: 'https://ha.example/base', haToken: 'secret' }, 'calendar.family', range,
    async (url, options) => {
      assert.equal(url.pathname, '/base/api/calendars/calendar.family');
      assert.equal(url.searchParams.get('start'), '2026-03-27T23:00:00Z');
      assert.equal(url.searchParams.get('end'), '2026-03-30T22:00:00Z');
      assert.equal(options.headers.authorization, 'Bearer secret');
      assert.equal(options.redirect, 'error');
      return new Response('[]');
    });
});

test('Machbar validates household privacy, range, semantics and strips metadata', () => {
  const demo = demoSources('2026-11-25T10:00:00Z', zone);
  const options = { ...demo.range, zone };
  const raw = structuredClone(demo.machbar);
  raw.days[2].tasks[0].notes = 'never leave the adapter';
  assert.equal(parseMachbar(raw, options).days[2].tasks[0].notes, undefined);
  for (const patch of [{ scope: 'work' }, { privacyOwnerMemberId: 1 }, { reason: 'available' }, { scheduledDate: null }]) {
    const invalid = structuredClone(demo.machbar);
    Object.assign(invalid.days[2].tasks[0], patch);
    assert.throws(() => parseMachbar(invalid, options));
  }
  assert.throws(() => parseMachbar({ ...raw, timeZone: 'UTC' }, options), /timezone/);
  assert.throws(() => parseMachbar({ ...raw, days: raw.days.slice(1) }, options), /range/);
});

test('evening is a local-day instant and never flips back in repeated DST hour', () => {
  assert.equal(displayPhase('2026-11-25T17:59:00Z', zone, '19:00').evening, false);
  assert.equal(displayPhase('2026-11-25T18:00:00Z', zone, '19:00').evening, true);
  assert.deepEqual(displayPhase('2026-11-25T23:00:00Z', zone, '19:00'), { evening: false, night: true });
  assert.equal(displayPhase('2026-10-25T01:15:00Z', zone, '02:30').evening, true);
});
