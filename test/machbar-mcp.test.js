import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fetchMachbarMcp } from '../lib/adapters/machbar-mcp.js';
import { loadConfig } from '../lib/config.js';
import { windowFor } from '../lib/dates.js';
import { Runtime } from '../lib/runtime.js';
import { buildProjection, visibleContent } from '../lib/projection.js';

const now = '2026-11-25T10:00:00Z';
const zone = 'Europe/Berlin';
const range = windowFor(now, zone);
const config = {
  demo: false, zone, machbarTransport: 'mcp',
  machbarMcpEndpoint: 'https://tasks.example/custom/mcp', machbarMcpToken: 'upstream-secret',
};
const json = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

function fixture() {
  const project = {
    id: 20, revision: 1, title: 'Gemeinsames Projekt', status: 'active',
    parentId: null, ownerMemberId: null, dueDate: range.today,
    scheduledDate: null, privacyOwnerMemberId: null, scope: 'household',
    ancestors: [], effectiveTags: [{ id: 4, name: 'not retained' }], notes: 'private notes',
  };
  const task = {
    id: 1, revision: 2, title: 'Altglas wegbringen', status: 'actionable', kind: 'action',
    projectId: 20, parentTaskId: null, effectiveOwnerId: 7,
    dueDate: null, scheduledDate: range.today, revisitAt: null,
    repeatAfterDays: null,
    privacyOwnerMemberId: null, scope: 'household', blocked: false, executable: true,
    ancestors: [{ id: 20, role: 'story', title: 'not retained' }],
    effectiveTags: [{ id: 4 }], externalRefs: [{ url: 'https://private.example' }], notes: 'private notes',
  };
  const deadline = {
    ...task, id: 2, title: 'Frist beachten', dueDate: range.today, blocked: true, executable: false,
  };
  const overdue = { ...task, id: 3, title: 'Überfällige Frist', dueDate: '2026-11-24', scheduledDate: null };
  const compact = (value) => Object.fromEntries([
    'id', 'revision', 'title', 'status', 'kind', 'projectId', 'effectiveOwnerId',
    'scheduledDate', 'dueDate', 'blocked',
  ].filter((field) => field in value).map((field) => [field, value[field]]));
  const compactProject = Object.fromEntries(['id', 'revision', 'title', 'status', 'ownerMemberId', 'dueDate'].map((field) => [field, project[field]]));
  const agenda = {
    planned: [compact(task)], dueToday: [compact(deadline)], overdue: [compact(overdue)],
    projects: [
      { project: compactProject, attentionBucket: 'dueToday' },
      { project: { id: 99 }, attentionBucket: 'dueSoon' },
    ],
    shared: [{ id: 500, notes: 'backlog must not be inspected' }],
    unscheduled: [{ id: 501 }], dueSoon: [{ id: 502 }], revisit: [{ id: 503 }], completedToday: [{ id: 504 }],
  };
  // Future project entries are still contract-validated, but never fetched.
  agenda.projects[1].project = { ...compactProject, id: 99, dueDate: '2026-11-27' };
  return { agenda, details: new Map([['task:1', task], ['task:2', deadline], ['task:3', overdue], ['project:20', project]]) };
}

function mockMcp(data, respond) {
  const calls = [];
  const fetcher = async (url, options) => {
    if (url.hostname === 'calendar.example') return json([]);
    assert.equal(url.href, config.machbarMcpEndpoint);
    assert.equal(options.method, 'POST');
    assert.equal(new Headers(options.headers).get('authorization'), `Bearer ${config.machbarMcpToken}`);
    assert.equal(url.search, '');
    assert.equal(options.redirect, 'error');
    const message = JSON.parse(options.body);
    calls.push(message);
    if (respond) {
      const overridden = await respond(message);
      if (overridden) return overridden;
    }
    if (message.method === 'initialize') {
      return json({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: message.params.protocolVersion, capabilities: { tools: {} },
        serverInfo: { name: 'synthetic', version: '1' },
      } });
    }
    if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
    assert.equal(message.method, 'tools/call');
    const { name, arguments: args } = message.params;
    assert.ok(['machbar_today', 'machbar_get_task', 'machbar_get_project'].includes(name));
    let result;
    if (name === 'machbar_today') {
      assert.deepEqual(args, { date: range.today });
      result = data.agenda;
    } else {
      const key = name === 'machbar_get_task' ? `task:${args.taskId}` : `project:${args.projectId}`;
      assert.ok(data.details.has(key), `unexpected detail: ${key}`);
      result = data.details.get(key);
    }
    return json({ jsonrpc: '2.0', id: message.id, result: {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: { result },
    } });
  };
  return { fetcher, calls };
}
const fetchFixture = (data, overrides) => fetchMachbarMcp(config, range, mockMcp(data, overrides).fetcher, now, () => now);

test('MCP uses only fixed reads and retains current-day commitments without private metadata', async () => {
  const data = fixture();
  const { fetcher, calls } = mockMcp(data);
  const result = await fetchMachbarMcp(config, range, fetcher, now, () => now);
  assert.deepEqual(result.days.map((day) => day.date), [range.today]);
  assert.deepEqual(result.days[0].tasks.map((task) => task.id), ['task:3', 'task:2', 'task:1', 'project:20']);
  assert.equal(result.days[0].tasks.find((task) => task.id === 'task:1').availableNow, null);
  assert.equal(calls.filter((call) => call.params?.name === 'machbar_get_project').length, 1);
  const serialized = JSON.stringify(result);
  for (const secret of ['upstream-secret', 'private notes', 'externalRefs', 'ancestors', 'private.example', 'not retained']) assert.ok(!serialized.includes(secret));
  const demo = await loadConfig({ DEMO_MODE: 'true' });
  const events = [{ id: 'family-event', date: '2026-11-26', title: 'Besuch', allDay: true, start: '2026-11-26', end: '2026-11-27' }];
  const options = { config: demo, now, machbar: result, events, health: [] };
  const projection = buildProjection(options);
  const today = projection.days.find((day) => day.date === range.today);
  assert.equal(today.tasks.find((task) => task.id === 'task:1').tag, 'Verfügbarkeit ungeprüft');
  assert.ok(today.tasks.find((task) => task.id === 'task:1').attention);
  assert.equal(today.tasks.find((task) => task.id === 'project:20').tag, 'Frist · Verfügbarkeit ungeprüft');
  assert.ok(!today.tasks.some((task) => task.id === 'task:2'));
  assert.deepEqual(projection.tomorrow.tasks, []);
  assert.deepEqual(projection.tomorrow.events, events);
  const evening = visibleContent(buildProjection({ ...options, now: '2026-11-25T18:00:00Z' }));
  assert.deepEqual(evening.shown.tasks, []);
  assert.equal(evening.shown.events.length, 1);
  assert.ok(evening.carried.some((task) => task.id === 'task:1'));
});

test('MCP excludes private items and inherited private ancestry', async () => {
  const privateItem = fixture();
  privateItem.details.get('task:1').privacyOwnerMemberId = 7;
  assert.ok(!(await fetchFixture(privateItem)).days[0].tasks.some((task) => task.id === 'task:1'));
  const privateParent = fixture();
  privateParent.details.get('project:20').privacyOwnerMemberId = 7;
  assert.deepEqual((await fetchFixture(privateParent)).days[0].tasks, []);
});

test('MCP rejects work scope, missing privacy/ancestry, racing revisions and duplicate commitments', async () => {
  for (const mutate of [
    (data) => { data.details.get('task:1').scope = 'work'; },
    (data) => { delete data.details.get('task:1').privacyOwnerMemberId; },
    (data) => { data.details.get('task:1').ancestors = []; },
    (data) => { data.details.get('task:1').revision++; },
    (data) => { data.details.get('task:1').ancestors[0].revision = 999; },
    (data) => { data.agenda.planned.push(data.agenda.planned[0]); },
    (data) => { data.details.get('project:20').ancestors = [{ id: 20, role: 'story' }]; },
  ]) {
    const data = fixture();
    mutate(data);
    await assert.rejects(fetchFixture(data), /^Error: source_mcp_/);
  }
});

test('MCP never revives missed one-off schedules, but preserves canonical recurring plans', async () => {
  const past = fixture();
  past.details.get('task:1').scheduledDate = '2026-11-24';
  past.agenda.planned[0].scheduledDate = '2026-11-24';
  const result = await fetchFixture(past);
  assert.ok(!result.days[0].tasks.some((task) => task.id === 'task:1'));
  assert.equal(result.excludedHistoricalPlans, 1);
  const future = fixture();
  future.details.get('task:1').scheduledDate = '2026-11-26';
  future.agenda.planned[0].scheduledDate = '2026-11-26';
  await assert.rejects(fetchFixture(future), /source_mcp_plan_invalid/);
  const recurring = fixture();
  recurring.details.get('task:1').scheduledDate = '2026-11-24';
  recurring.details.get('task:1').repeatAfterDays = 7;
  recurring.agenda.planned[0].scheduledDate = '2026-11-24';
  assert.ok((await fetchFixture(recurring)).days[0].tasks.some((task) => task.id === 'task:1'));
});

test('MCP enforces the detail budget rather than silently truncating commitments', async () => {
  const data = fixture();
  const base = data.details.get('task:1');
  data.agenda.planned = Array.from({ length: 101 }, (_, index) => {
    const task = { ...base, id: index + 100, projectId: null, ancestors: [] };
    data.details.set(`task:${task.id}`, task);
    return { ...task };
  });
  await assert.rejects(fetchFixture(data), /source_mcp_detail_limit/);
});

test('MCP bounds responses and redacts upstream errors', async () => {
  for (const [response, code] of [
    [() => new Response('private failure', { status: 401 }), 'source_unauthorized'],
    [() => new Response('x'.repeat(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } }), 'source_response_too_large'],
    [() => new Response('data: private', { headers: { 'content-type': 'text/event-stream' } }), 'source_mcp_json_required'],
  ]) {
    await assert.rejects(fetchFixture(fixture(), response), (error) => error.message === code);
  }
  await assert.rejects(fetchFixture(fixture(), (message) => message.method === 'tools/call' && json({
    jsonrpc: '2.0', id: message.id,
    result: { isError: true, content: [{ type: 'text', text: 'private upstream error' }] },
  })), (error) => error.message === 'source_mcp_tool_error');
});

test('MCP rejects midnight-crossing refreshes and never reaches live services in demo', async () => {
  await assert.rejects(fetchMachbarMcp(config, range, mockMcp(fixture()).fetcher, now, () => '2026-11-25T23:00:00Z'), /source_mcp_day_changed/);
  await assert.rejects(fetchMachbarMcp({ ...config, demo: true }, range, () => assert.fail('live request')), /forbidden_in_demo/);
  const demo = await loadConfig({ DEMO_MODE: 'true', MACHBAR_MCP_ENDPOINT: config.machbarMcpEndpoint, MACHBAR_TOKEN: 'never-use' });
  const runtime = new Runtime(demo, { clock: () => now, fetcher: () => assert.fail('live request') });
  await runtime.init();
  await runtime.refreshAll();
  assert.ok(runtime.snapshot().days.some((day) => day.tasks.length));
});

test('MCP production config accepts endpoint/token settings and fails closed on unsafe combinations', async (t) => {
  const env = {
    MACHBAR_MCP_ENDPOINT: config.machbarMcpEndpoint, MACHBAR_TOKEN: config.machbarMcpToken,
    HA_URL: 'https://calendar.example', HA_TOKEN: 'calendar-secret', HA_CALENDAR_ENTITIES: 'calendar.synthetic',
    PUBLIC_URL: 'https://frame.example', OIDC_ISSUER: 'https://id.example',
    OIDC_CLIENT_ID: 'client', OIDC_CLIENT_SECRET: 'client-secret', OIDC_ALLOWED_SUBJECTS: 'household',
    DISPLAY_TOKEN: 'd'.repeat(32), WORKER_TOKEN: 'w'.repeat(32), ADMIN_TOKEN: 'a'.repeat(32),
  };
  const parsed = await loadConfig(env);
  assert.equal(parsed.machbarTransport, 'mcp');
  assert.equal(parsed.machbarMcpToken, config.machbarMcpToken);
  for (const patch of [
    { MACHBAR_TRANSPORT: 'automatic' }, { MACHBAR_TRANSPORT: 'rest' },
    { MACHBAR_MCP_ENDPOINT: 'http://tasks.example/mcp' },
    { MACHBAR_MCP_ENDPOINT: 'https://tasks.example/mcp?token=secret' },
    { MACHBAR_MCP_ENDPOINT: 'https://user:secret@tasks.example/mcp' },
    { MACHBAR_TOKEN: '' }, { MACHBAR_TOKEN: env.DISPLAY_TOKEN }, { TZ: 'UTC' },
  ]) await assert.rejects(loadConfig({ ...env, ...patch }));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-mcp-config-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  for (const preference of ['showRevisits', 'showCompletedRecap']) {
    await fs.writeFile(file, JSON.stringify({ [preference]: true }));
    await assert.rejects(loadConfig({ ...env, DASHBOARD_CONFIG: file }), /only current-day/);
  }
});

test('MCP cache is transport/credential scoped, stale on failure and unavailable after local midnight', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-mcp-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const parsed = await loadConfig({ DEMO_MODE: 'true' });
  const settings = { ...parsed, ...config, dataDir: dir, haUrl: 'https://calendar.example', haToken: 'calendar-secret', calendars: ['calendar.synthetic'] };
  let time = now;
  let fail = false;
  const { fetcher } = mockMcp(fixture(), () => fail ? new Response('private failure', { status: 503 }) : undefined);
  const runtime = new Runtime(settings, { clock: () => time, fetcher });
  await runtime.refreshAll();
  assert.equal(runtime.snapshot().health[0].state, 'ok');
  fail = true;
  await runtime.refreshAll();
  assert.equal(runtime.snapshot().health[0].state, 'stale');
  assert.equal(runtime.snapshot().health[1].state, 'ok');
  assert.ok(runtime.snapshot().days.some((day) => day.tasks.length));
  const persisted = await fs.readFile(path.join(dir, 'sources.json'), 'utf8');
  assert.ok(!persisted.includes(config.machbarMcpToken) && !persisted.includes('private notes'));
  const restarted = new Runtime(settings, { clock: () => time });
  await restarted.init();
  assert.equal(restarted.snapshot().health[0].state, 'stale');
  for (const patch of [{ machbarTransport: 'rest' }, { machbarMcpToken: 'rotated' }, { machbarMcpEndpoint: 'https://other.example/mcp' }]) {
    const changed = new Runtime({ ...settings, ...patch }, { clock: () => time });
    await changed.init();
    assert.equal(changed.sources.size, 0);
  }
  time = '2026-11-25T23:00:00Z';
  assert.equal(restarted.snapshot().health[0].state, 'unavailable');
  assert.ok(restarted.snapshot().days.every((day) => day.tasks.length === 0));
});
