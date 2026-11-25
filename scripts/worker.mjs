import { spawn } from 'node:child_process';

const child = spawn(process.env.PYTHON || 'python', ['-m', 'frame_worker', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    PYTHONPATH: 'worker',
    DASHBOARD_BACKEND_URL: process.env.DASHBOARD_BACKEND_URL || 'http://127.0.0.1:4321',
    ART_STATE_DIR: process.env.ART_STATE_DIR || 'data/art-worker',
    ART_CONTROL_DIR: process.env.ART_CONTROL_DIR || 'data/art-control',
  },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.once('error', () => {
  process.stderr.write('Worker could not start; activate the documented Python environment.\n');
  process.exitCode = 1;
});
child.once('exit', (code) => { process.exitCode = code ?? 1; });
