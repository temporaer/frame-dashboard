import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { endpoint } from '../request.js';
import { dateAt } from '../dates.js';
import { localDate } from './machbar.js';

const id = z.number().int().positive();
const title = z.string().trim().min(1).max(1000);
const stamp = z.string().datetime({ offset: true });
const reference = z.object({ id, role: z.enum(['task', 'story']), revision: z.number().int().nonnegative().optional() });
const taskStatus = z.enum(['captured', 'actionable', 'someday', 'done', 'cancelled']);
const projectStatus = z.enum(['active', 'backlog', 'completed', 'archived']);
const common = {
  id, revision: z.number().int().nonnegative(), title,
  scope: z.enum(['household', 'work']),
  privacyOwnerMemberId: id.nullable(),
  dueDate: localDate.nullable(),
  scheduledDate: localDate.nullable(),
  ancestors: z.array(reference).max(100),
  effectiveTags: z.array(z.object({ id })).max(2000),
};
const taskDetail = z.object({
  ...common, parentTaskId: id.nullable(), projectId: id.nullable(),
  effectiveOwnerId: id.nullable(), blocked: z.boolean(), executable: z.boolean(),
  status: taskStatus, kind: z.enum(['action', 'reference']),
  revisitAt: stamp.nullable(),
  repeatAfterDays: z.number().int().positive().nullable(),
});
const projectDetail = z.object({ ...common, parentId: id.nullable(), ownerMemberId: id.nullable(), status: projectStatus });
const compactTask = z.object({
  id, revision: z.number().int().nonnegative(), title,
  kind: z.literal('action'), status: taskStatus,
  projectId: id.nullable(), effectiveOwnerId: id.nullable(),
  scheduledDate: localDate.nullable(), dueDate: localDate.nullable(),
  blocked: z.boolean(),
});
const compactProject = z.object({
  id, revision: z.number().int().nonnegative(), title, status: projectStatus,
  ownerMemberId: id.nullable(), dueDate: localDate.nullable(),
});
const agendaSchema = z.object({
  planned: z.array(compactTask).max(2000),
  overdue: z.array(compactTask).max(2000),
  dueToday: z.array(compactTask).max(2000),
  projects: z.array(z.object({
    project: compactProject,
    attentionBucket: z.enum(['overdue', 'dueToday', 'dueSoon', 'planned']),
  })).max(2000),
});
const READ_TOOLS = new Set(['machbar_today', 'machbar_get_task', 'machbar_get_project']);

async function boundedResponse(response) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(response.status === 401 || response.status === 403 ? 'source_unauthorized' : `source_http_${response.status}`);
  }
  if (response.status === 202 || response.status === 204) {
    await response.body?.cancel();
    return new Response(null, { status: response.status, headers: response.headers });
  }
  if (response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
    await response.body?.cancel();
    throw new Error('source_mcp_json_required');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 2 * 1024 * 1024) {
        await reader.cancel();
        throw new Error('source_response_too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new Response(Buffer.concat(chunks), { status: response.status, headers: response.headers });
}

export async function fetchMachbarMcp(config, range, fetcher = fetch, now = new Date().toISOString(), clock = () => new Date().toISOString()) {
  if (config.demo) throw new Error('source_mcp_forbidden_in_demo');
  if (config.zone !== 'Europe/Berlin') throw new Error('source_mcp_timezone_unsupported');
  const url = config.machbarMcpEndpoint ? new URL(config.machbarMcpEndpoint) : endpoint(config.machbarUrl, 'api/mcp');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('source_mcp_endpoint_invalid');
  if (!config.machbarMcpToken) throw new Error('source_mcp_token_required');
  const signal = AbortSignal.timeout(30000);
  const client = new Client({ name: 'frame-dashboard', version: '0.1.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${config.machbarMcpToken}` }, redirect: 'error' },
    fetch: async (target, options) => {
      if (String(target) !== url.href) throw new Error('source_mcp_endpoint_forbidden');
      // This adapter deliberately does not subscribe to server-initiated events.
      if (options.method === 'GET') return new Response(null, { status: 405 });
      if (options.method !== 'POST' || typeof options.body !== 'string') throw new Error('source_mcp_method_forbidden');
      const message = JSON.parse(options.body);
      if (!['initialize', 'notifications/initialized'].includes(message.method) &&
          !(message.method === 'tools/call' && READ_TOOLS.has(message.params?.name))) {
        throw new Error('source_mcp_method_forbidden');
      }
      return boundedResponse(await fetcher(url, {
        ...options, redirect: 'error',
        signal: AbortSignal.any([signal, ...(options.signal ? [options.signal] : [])]),
      }));
    },
  });
  const requestOptions = { signal, timeout: 15000 };
  const read = async (name, args) => {
    const response = await client.callTool({ name, arguments: args }, undefined, requestOptions);
    if (response.isError) throw new Error('source_mcp_tool_error');
    if (!response.structuredContent || !Object.hasOwn(response.structuredContent, 'result')) throw new Error('source_mcp_result_missing');
    return response.structuredContent.result;
  };
  try {
    await client.connect(transport, requestOptions);
    const agenda = agendaSchema.parse(await read('machbar_today', { date: range.today }));
    const details = new Map();
    const detailFor = async (role, itemId) => {
      const key = `${role}:${itemId}`;
      if (!details.has(key)) {
        if (details.size >= 100) throw new Error('source_mcp_detail_limit');
        const detail = role === 'task'
          ? taskDetail.parse(await read('machbar_get_task', { taskId: itemId }))
          : projectDetail.parse(await read('machbar_get_project', { projectId: itemId }));
        if (detail.id !== itemId) throw new Error('source_mcp_identity_mismatch');
        if (detail.scope !== 'household') throw new Error('source_mcp_household_required');
        const parentIds = role === 'task' ? [detail.parentTaskId, detail.projectId] : [detail.parentId];
        if (parentIds.some((parent) => parent !== null && !detail.ancestors.some((ancestor) => ancestor.id === parent))) {
          throw new Error('source_mcp_ancestry_incomplete');
        }
        details.set(key, detail);
      }
      return details.get(key);
    };
    const safety = new Map();
    const householdSafe = async (role, detail, path = new Set()) => {
      const key = `${role}:${detail.id}`;
      if (path.has(key)) throw new Error('source_mcp_ancestry_cycle');
      if (safety.has(key)) return safety.get(key);
      if (detail.privacyOwnerMemberId !== null) return false;
      const next = new Set([...path, key]);
      for (const ancestor of detail.ancestors) {
        const ancestorRole = ancestor.role === 'story' ? 'project' : 'task';
        const parent = await detailFor(ancestorRole, ancestor.id);
        if (ancestor.revision !== undefined && ancestor.revision !== parent.revision) throw new Error('source_mcp_snapshot_changed');
        if (!await householdSafe(ancestorRole, parent, next)) return false;
      }
      safety.set(key, true);
      return true;
    };
    const tasks = [];
    const seen = new Set();
    let excludedHistoricalPlans = 0;
    const add = async (role, compact, reason) => {
      const key = `${role}:${compact.id}`;
      if (seen.has(key)) throw new Error('source_mcp_duplicate_identity');
      seen.add(key);
      const detail = await detailFor(role, compact.id);
      for (const field of Object.keys(compact)) {
        if (JSON.stringify(compact[field]) !== JSON.stringify(detail[field])) throw new Error('source_mcp_snapshot_changed');
      }
      if (!await householdSafe(role, detail)) return;
      if (role === 'task' && detail.status !== 'actionable' && reason === 'planned') throw new Error('source_mcp_plan_invalid');
      if (['done', 'cancelled', 'completed', 'archived'].includes(detail.status)) throw new Error('source_mcp_terminal_item');
      if (reason === 'planned' && !detail.scheduledDate) throw new Error('source_mcp_plan_invalid');
      if (reason === 'planned' && detail.scheduledDate > range.today) throw new Error('source_mcp_plan_invalid');
      if (reason === 'planned' && detail.scheduledDate < range.today && detail.repeatAfterDays === null) {
        excludedHistoricalPlans++;
        return;
      }
      if (reason === 'overdue' && !(detail.dueDate && detail.dueDate < range.today)) throw new Error('source_mcp_deadline_invalid');
      if (reason === 'deadline' && detail.dueDate !== range.today) throw new Error('source_mcp_deadline_invalid');
      tasks.push({
        id: key, title: detail.title, role,
        parentId: role === 'task' && detail.parentTaskId ? `task:${detail.parentTaskId}` : null,
        projectId: role === 'task' && detail.projectId ? `project:${detail.projectId}` : null,
        scope: detail.scope, privacyOwnerMemberId: detail.privacyOwnerMemberId,
        effectiveOwnerId: role === 'task' ? detail.effectiveOwnerId : detail.ownerMemberId,
        ownerLabel: null, scheduledDate: role === 'task' ? detail.scheduledDate : null,
        dueDate: detail.dueDate, revisitAt: null, completedAt: null, reason,
        blocked: role === 'task' ? detail.blocked : false,
        executable: role === 'task' ? detail.executable : null,
        // MCP does not expose the canonical combined window/context availability.
        availableNow: null,
        tagIds: detail.effectiveTags.map((tag) => tag.id),
      });
    };
    for (const [bucket, reason] of [['overdue', 'overdue'], ['dueToday', 'deadline'], ['planned', 'planned']]) {
      for (const task of agenda[bucket]) await add('task', task, reason);
    }
    for (const entry of agenda.projects) {
      if (['overdue', 'dueToday'].includes(entry.attentionBucket)) {
        await add('project', entry.project, entry.attentionBucket === 'overdue' ? 'overdue' : 'deadline');
      }
    }
    if (dateAt(now, config.zone) !== range.today || dateAt(clock(), config.zone) !== range.today) {
      throw new Error('source_mcp_day_changed');
    }
    return { version: 1, timeZone: config.zone, generatedAt: now, currentDate: range.today, excludedHistoricalPlans, days: [{ date: range.today, tasks }] };
  } catch (error) {
    throw new Error(/^source_[a-z0-9_]+$/.test(error.message) ? error.message : 'source_mcp_contract_or_connection_error');
  } finally {
    await client.close();
  }
}
