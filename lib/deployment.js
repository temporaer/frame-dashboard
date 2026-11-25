import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { z } from 'zod';
import { readState, writeState } from './storage.js';

const OWNER = 'io.github.temporaer.frame-dashboard.deployment';
const COMPONENT = 'io.github.temporaer.frame-dashboard.component';
const imageId = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const containerId = z.string().regex(/^[a-f0-9]{12,64}$/);
const stateSchema = z.strictObject({
  version: z.literal(1), deploymentId: z.uuid(),
  project: z.string(), image: z.string(),
});
const READY = "fetch('http://127.0.0.1:4321/api/health',{headers:{authorization:'Bearer '+process.env.ADMIN_TOKEN},signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))";

export async function deployDashboard({
  root, run, compose, project = 'frame-dashboard', image = 'frame-dashboard-core:local',
  wait = pause, clock = Date.now, log = () => {},
}) {
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project) ||
      !/^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9_.-]+$/.test(image)) throw new Error('deployment_name_invalid');
  const directory = path.join(root, 'data', 'deploy');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, 'lock');
  try { await fs.mkdir(lock); } catch (error) {
    if (error.code === 'EEXIST') throw new Error('deployment_locked');
    throw error;
  }
  const iid = path.join(directory, 'candidate.iid');
  const composeRun = (args) => run(compose[0], [...compose.slice(1), '-f', path.join(root, 'compose.yml'), '-p', project, ...args]);
  const containerImage = async (container) => imageId.parse((await run('docker', ['inspect', '--format', '{{.Image}}', container])).trim());
  const imageOwner = async (id) => (await run('docker', ['image', 'inspect', '--format', `{{index .Config.Labels "${OWNER}"}}`, id])).trim();
  try {
    const file = path.join(directory, 'state.json');
    const saved = await readState(file);
    const state = saved ? stateSchema.parse(saved) : { version: 1, deploymentId: randomUUID(), project, image };
    if (state.project !== project || state.image !== image) throw new Error('deployment_identity_changed');
    if (!saved) await writeState(file, state);
    const existing = (await composeRun(['ps', '-q', 'dashboard'])).trim();
    if (existing && await imageOwner(await containerImage(containerId.parse(existing))) !== state.deploymentId) {
      throw new Error('deployment_container_not_owned');
    }
    const tagged = (await run('docker', ['image', 'ls', '--quiet', '--no-trunc', '--filter', `reference=${image}`])).trim();
    if (tagged && await imageOwner(imageId.parse(tagged)) !== state.deploymentId) throw new Error('deployment_image_tag_not_owned');

    log({ event: 'deployment_building' });
    await run('docker', [
      'build', '--quiet', '--iidfile', iid,
      '--label', `${OWNER}=${state.deploymentId}`, '--label', `${COMPONENT}=dashboard`,
      '--tag', image, '.',
    ], { timeout: 600000 });
    const candidate = imageId.parse((await fs.readFile(iid, 'utf8')).trim());
    if (await imageOwner(candidate) !== state.deploymentId) throw new Error('deployment_image_not_owned');
    if (existing) {
      // Compose v1 cannot recreate containers against recent Docker image metadata.
      await composeRun(['stop', 'dashboard']);
      await composeRun(['rm', '--force', 'dashboard']);
    }
    await composeRun(['up', '-d', '--no-build', 'dashboard']);
    const container = containerId.parse((await composeRun(['ps', '-q', 'dashboard'])).trim());
    if (await containerImage(container) !== candidate) throw new Error('deployment_image_mismatch');
    let ready = false;
    const deadline = clock() + 90000;
    while (clock() < deadline) {
      if ((await run('docker', ['inspect', '--format', '{{.State.Running}}', container])).trim() !== 'true') {
        throw new Error('deployment_container_not_running');
      }
      try {
        await run('docker', ['exec', container, 'node', '-e', READY]);
        ready = true;
        break;
      } catch {
        await wait(1000);
      }
    }
    if (!ready) throw new Error('deployment_readiness_timeout');

    const owned = (await run('docker', [
      'image', 'ls', '--quiet', '--no-trunc',
      '--filter', `label=${OWNER}=${state.deploymentId}`,
      '--filter', `label=${COMPONENT}=dashboard`,
    ])).trim().split(/\s+/).filter(Boolean);
    let removed = 0;
    let retainedInUse = 0;
    for (const id of new Set(owned.map((value) => imageId.parse(value)))) {
      if (id === candidate) continue;
      if (await imageOwner(id) !== state.deploymentId) throw new Error('deployment_cleanup_ownership_mismatch');
      const users = (await run('docker', ['ps', '-aq', '--filter', `ancestor=${id}`])).trim();
      if (users) {
        retainedInUse++;
        log({ event: 'image_cleanup_skipped_in_use' });
        continue;
      }
      await run('docker', ['image', 'rm', id]);
      removed++;
    }
    log({ event: 'deployment_ready', removedImages: removed, retainedInUse });
    return { removed, retainedInUse };
  } finally {
    await fs.rm(iid, { force: true });
    await fs.rmdir(lock);
  }
}
