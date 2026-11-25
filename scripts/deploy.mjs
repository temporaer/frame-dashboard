import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { deployDashboard } from '../lib/deployment.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const execute = promisify(execFile);
const log = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
let stage = 'configuration';
try {
  process.loadEnvFile(path.join(root, '.env'));
  const config = await loadConfig({
    ...process.env, DASHBOARD_CONFIG: path.join(root, 'config.json'),
    DATA_DIR: path.join(root, 'data'),
  });
  if (config.demo || config.artEnabled || config.brightness.enabled) throw new Error('deployment_requires_live_core_only');
  const run = async (command, args, options = {}) => {
    const { stdout } = await execute(command, args, {
      cwd: root, env: process.env, timeout: options.timeout || 15000, maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  };
  stage = 'docker_access';
  await run('docker', ['info', '--format', '{{.ServerVersion}}']);
  let compose;
  try {
    await run('docker', ['compose', 'version']);
    compose = ['docker', 'compose'];
  } catch {
    await run('docker-compose', ['version', '--short']);
    compose = ['docker-compose'];
  }
  stage = 'build_start_readiness_cleanup';
  await deployDashboard({
    root, run, compose, log,
    project: process.env.COMPOSE_PROJECT_NAME || 'frame-dashboard',
    image: process.env.DASHBOARD_IMAGE || 'frame-dashboard-core:local',
  });
} catch (error) {
  log({ event: 'deployment_failed', stage, code: /^deployment_[a-z0-9_]+$/.test(error.message) ? error.message : 'deployment_command_or_configuration_failed' });
  process.exitCode = 1;
}
