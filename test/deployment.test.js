import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deployDashboard } from '../lib/deployment.js';

const owner = '00000000-0000-4000-8000-000000000001';
const current = `sha256:${'a'.repeat(64)}`;
const previous = `sha256:${'b'.repeat(64)}`;
const older = `sha256:${'c'.repeat(64)}`;
const container = 'd'.repeat(64);
const foreign = `sha256:${'e'.repeat(64)}`;

async function setup(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-deploy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'data', 'deploy');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({
    version: 1, deploymentId: owner, project: 'frame-dashboard', image: 'frame-dashboard-core:local',
  }));
  const calls = [];
  const logs = [];
  let started = false;
  let time = 0;
  const run = async (command, args) => {
    calls.push([command, ...args]);
    if (command === 'docker-compose') {
      assert.deepEqual(args.slice(0, 4), ['-f', path.join(root, 'compose.yml'), '-p', 'frame-dashboard']);
      const action = args.slice(4);
      assert.equal(action.at(-1), 'dashboard');
      if (action[0] === 'ps') return started || options.existing ? container : '';
      if (action[0] === 'up') started = true;
      return '';
    }
    assert.equal(command, 'docker');
    if (args[0] === 'build') {
      if (options.buildFailure) throw new Error('private daemon error');
      assert.ok(args.includes(`io.github.temporaer.frame-dashboard.deployment=${owner}`));
      await fs.writeFile(args[args.indexOf('--iidfile') + 1], current);
      return '';
    }
    if (args[0] === 'inspect') {
      if (args[2] === '{{.Image}}') return !started && options.existing ? previous : current;
      if (args[2] === '{{.State.Running}}') return 'true';
    }
    if (args[0] === 'exec') {
      if (options.unhealthy) throw new Error('not ready');
      return '';
    }
    if (args[0] === 'ps') return options.inUse && args.includes(`ancestor=${older}`) ? 'another-container' : '';
    if (args[0] === 'image') {
      if (args[1] === 'inspect') return args.at(-1) === foreign || (options.foreignOwner && args.at(-1) === previous) ? 'another-deployment' : owner;
      if (args[1] === 'ls') {
        if (args.includes('reference=frame-dashboard-core:local')) return options.tagCollision ? foreign : '';
        assert.ok(args.includes(`label=io.github.temporaer.frame-dashboard.deployment=${owner}`));
        assert.ok(args.includes('label=io.github.temporaer.frame-dashboard.component=dashboard'));
        return [current, previous, older, previous].join('\n');
      }
      if (args[1] === 'rm') {
        assert.ok([previous, older].includes(args[2]));
        assert.equal(args.length, 3);
        assert.ok(!args.includes('--force') && !args.includes('-f'));
        return '';
      }
    }
    assert.fail(`unexpected command ${command} ${args.join(' ')}`);
  };
  return {
    root, calls, logs,
    deploy: () => deployDashboard({
      root, run, compose: ['docker-compose'], log: (event) => logs.push(event),
      clock: () => time, wait: async (delay) => { time += delay; },
    }),
  };
}

test('deployment removes every owned superseded image only after readiness, retaining the running image', async (t) => {
  const fixture = await setup(t, { existing: true });
  assert.deepEqual(await fixture.deploy(), { removed: 2, retainedInUse: 0 });
  const calls = fixture.calls;
  assert.deepEqual(calls.filter((call) => call[1] === 'image' && call[2] === 'rm').map((call) => call[3]), [previous, older]);
  const readyAt = calls.findIndex((call) => call[1] === 'exec');
  const firstRemoval = calls.findIndex((call) => call[1] === 'image' && call[2] === 'rm');
  assert.ok(firstRemoval > readyAt);
  assert.ok(!calls.some((call) => call.includes('prune') || call.includes(foreign)));
  const buildAt = calls.findIndex((call) => call[1] === 'build');
  const stopAt = calls.findIndex((call) => call[0] === 'docker-compose' && call[5] === 'stop');
  assert.ok(stopAt > buildAt);
  await assert.rejects(fs.access(path.join(fixture.root, 'data', 'deploy', 'lock')));
});

test('deployment never deletes an owned old image referenced by any other container', async (t) => {
  const fixture = await setup(t, { inUse: true });
  assert.deepEqual(await fixture.deploy(), { removed: 1, retainedInUse: 1 });
  assert.ok(fixture.logs.some((event) => event.event === 'image_cleanup_skipped_in_use'));
  assert.ok(!fixture.calls.some((call) => call[1] === 'image' && call[2] === 'rm' && call[3] === older));
});

test('build or readiness failure preserves old images, with no pruning or pre-build container stop', async (t) => {
  for (const options of [{ buildFailure: true, existing: true }, { unhealthy: true }]) {
    const fixture = await setup(t, options);
    await assert.rejects(fixture.deploy());
    assert.ok(!fixture.calls.some((call) => call[1] === 'image' && call[2] === 'rm'));
    if (options.buildFailure) assert.ok(!fixture.calls.some((call) => call[0] === 'docker-compose' && call[5] === 'stop'));
    await assert.rejects(fs.access(path.join(fixture.root, 'data', 'deploy', 'lock')));
  }
});

test('deployment refuses to replace or delete images belonging to another deployment', async (t) => {
  const fixture = await setup(t, { existing: true, foreignOwner: true });
  await assert.rejects(fixture.deploy(), /container_not_owned/);
  assert.ok(!fixture.calls.some((call) => call[1] === 'build' || call.includes('stop') || call.includes('rm')));
  const cleanup = await setup(t, { foreignOwner: true });
  await assert.rejects(cleanup.deploy(), /cleanup_ownership_mismatch/);
  assert.ok(!cleanup.calls.some((call) => call[1] === 'image' && call[2] === 'rm'));
  const collision = await setup(t, { tagCollision: true });
  await assert.rejects(collision.deploy(), /image_tag_not_owned/);
  assert.ok(!collision.calls.some((call) => call[1] === 'build'));
});
