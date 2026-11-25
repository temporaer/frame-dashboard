import { createHash } from 'node:crypto';
import { artFor } from './art.js';
import { displayPhase, plusDays, windowFor, datesBetween } from './dates.js';

const REASONS = { overdue: 0, deadline: 1, planned: 2, revisit: 3, completed: 4 };

function tasksFor(tasks, preferences) {
  const visible = tasks.filter((task) =>
    task.scope === 'household' && task.privacyOwnerMemberId === null &&
    (task.reason !== 'revisit' || preferences.showRevisits) &&
    (task.reason !== 'completed' || preferences.showCompletedRecap) &&
    (!preferences.ownerIds.length || preferences.ownerIds.includes(task.effectiveOwnerId)) &&
    (!preferences.projectIds.length || preferences.projectIds.includes(task.projectId)) &&
    (!preferences.tagIds.length || task.tagIds.some((id) => preferences.tagIds.includes(id))),
  );
  const projectDates = new Map(visible.filter((t) => t.role === 'project').map((t) => [t.id, t.dueDate]));
  return visible.filter((task) => {
    // A project deadline remains a distinct attention item; omit matching
    // child deadline rows, not independently scheduled child work.
    return !(task.projectId && projectDates.has(task.projectId) && projectDates.get(task.projectId) === task.dueDate && ['deadline', 'overdue'].includes(task.reason));
  }).sort((a, b) => REASONS[a.reason] - REASONS[b.reason]).map((task) => {
    let tag = task.reason === 'overdue' ? 'Überfällig' :
      task.reason === 'deadline' ? 'Frist' :
      task.reason === 'revisit' ? 'Wiedervorlage' : null;
    if (task.blocked || task.executable === false || task.availableNow === false) tag = tag ? `${tag} · Hinweis` : 'Noch nicht ausführbar';
    else if (task.executable === null || task.availableNow === null) tag = tag ? `${tag} · Verfügbarkeit ungeprüft` : 'Verfügbarkeit ungeprüft';
    if (preferences.showOwners && task.ownerLabel) tag = [tag, task.ownerLabel].filter(Boolean).join(' · ');
    return { id: task.id, text: task.title, done: task.reason === 'completed', tag, reason: task.reason, attention: task.reason !== 'planned' || !task.executable || !task.availableNow };
  });
}

export function buildProjection({ config, now, machbar, events, health }) {
  const range = windowFor(now, config.zone);
  const days = datesBetween(range.start, range.end).map((date) => ({
    date, focus: null, note: null,
    tasks: tasksFor(machbar?.days.find((d) => d.date === date)?.tasks || [], config.presentation),
    events: events.filter((e) => e.date === date).sort((a, b) =>
      Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start) || a.id.localeCompare(b.id)),
    art: artFor(date, config.presentation.packs),
  }));
  const phase = displayPhase(now, config.zone, config.presentation.eveningTransition);
  return {
    schemaVersion: 1, tz: config.zone, locale: config.locale,
    today: range.today, weekOf: range.start, days: days.slice(0, 7),
    tomorrow: days.find((d) => d.date === plusDays(range.today, 1)),
    phase, layout: config.presentation.layout, planned: true, focus: null,
    generatedAt: now, health,
    preferences: {
      eveningTransition: config.presentation.eveningTransition,
      maxVisibleTasks: config.presentation.maxVisibleTasks,
      showCompletedRecap: config.presentation.showCompletedRecap,
      refreshSeconds: config.liveSeconds,
    },
    errors: health.filter((h) => h.state !== 'ok').map((h) => `${h.label}: ${h.state === 'stale' ? 'Daten veraltet' : 'nicht verfügbar'}`),
  };
}

export function visibleContent(projection, build = 'dev') {
  const today = projection.days.find((d) => d.date === projection.today);
  const shown = projection.phase.evening ? projection.tomorrow : today;
  const now = Date.parse(projection.generatedAt);
  const cleanDay = (day) => day && ({
    date: day.date, tasks: day.tasks, art: day.art,
    events: day.events.map((e) => ({
      ...e, state: e.allDay ? 'allDay' : Date.parse(e.end) <= now ? 'completed' : Date.parse(e.start) <= now ? 'current' : 'upcoming',
    })),
  });
  return {
    build, today: projection.today, layout: projection.layout,
    locale: projection.locale, tz: projection.tz, preferences: projection.preferences,
    phase: projection.phase, shown: cleanDay(shown),
    carried: projection.phase.evening ? today?.tasks.filter((t) => !t.done) : [],
    // The mini-week shows only event counts, not relative times.
    week: projection.days.map((d) => [d.date, d.events.filter((e) => !e.allDay).length]),
    artwork: today?.art,
    health: projection.health.map(({ source, state }) => ({ source, state })),
  };
}

export function fingerprint(projection, build) {
  return createHash('sha256').update(JSON.stringify(visibleContent(projection, build))).digest('hex');
}
