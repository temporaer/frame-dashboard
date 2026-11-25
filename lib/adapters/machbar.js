import { z } from 'zod';
import { Temporal } from '@js-temporal/polyfill';
import { datesBetween } from '../dates.js';
import { endpoint, fetchJson } from '../request.js';

export const localDate = z.string().refine((value) => {
  try { return Temporal.PlainDate.from(value).toString() === value; } catch { return false; }
});
const instant = z.string().refine((value) => {
  try { Temporal.Instant.from(value); return true; } catch { return false; }
});
const identifier = z.string().regex(/^(task|project):[1-9]\d*$/);
const taskSchema = z.object({
  id: identifier,
  title: z.string().trim().min(1).max(1000),
  role: z.enum(['task', 'project']),
  parentId: identifier.nullable(),
  projectId: identifier.nullable(),
  scope: z.literal('household'),
  privacyOwnerMemberId: z.null(),
  effectiveOwnerId: z.number().int().positive().nullable(),
  ownerLabel: z.string().max(20).nullable(),
  scheduledDate: localDate.nullable(),
  dueDate: localDate.nullable(),
  revisitAt: instant.nullable(),
  completedAt: instant.nullable(),
  reason: z.enum(['planned', 'deadline', 'overdue', 'revisit', 'completed']),
  blocked: z.boolean(),
  availableNow: z.boolean(),
  executable: z.boolean(),
  tagIds: z.array(z.number().int().positive()),
}).refine((t) => t.id.startsWith(`${t.role}:`), 'Role/identity mismatch');
const envelope = z.object({
  version: z.literal(1),
  timeZone: z.string(),
  generatedAt: instant,
  days: z.array(z.object({ date: localDate, tasks: z.array(taskSchema).max(2000) })).max(15),
});

export function parseMachbar(raw, { start, end, zone }) {
  const parsed = envelope.parse(raw);
  if (parsed.timeZone !== zone) throw new Error('machbar_timezone_mismatch');
  const expected = datesBetween(start, end);
  const received = parsed.days.map((d) => d.date).sort();
  if (JSON.stringify(received) !== JSON.stringify(expected)) throw new Error('machbar_range_incomplete');
  for (const day of parsed.days) {
    if (new Set(day.tasks.map((t) => t.id)).size !== day.tasks.length) throw new Error('machbar_duplicate_identity');
    for (const task of day.tasks) {
      if ((task.reason === 'completed') !== (task.completedAt !== null)) throw new Error('machbar_completion_invalid');
      if (task.reason === 'planned' && (!task.scheduledDate || task.role !== 'task')) throw new Error('machbar_plan_invalid');
      if (['deadline', 'overdue'].includes(task.reason) && !task.dueDate) throw new Error('machbar_deadline_invalid');
      if (task.reason === 'revisit' && !task.revisitAt) throw new Error('machbar_revisit_invalid');
    }
  }
  return parsed;
}

export async function fetchMachbar(config, range, fetcher) {
  const url = endpoint(config.machbarUrl, 'api/integrations/frame-dashboard/projection');
  url.searchParams.set('start', range.start);
  url.searchParams.set('end', range.end);
  return parseMachbar(await fetchJson(url, config.machbarToken, fetcher), { ...range, zone: config.zone });
}
