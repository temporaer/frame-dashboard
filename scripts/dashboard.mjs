import { loadConfig, loadCalendarConnection } from '../lib/config.js';
import { Runtime } from '../lib/runtime.js';
import { discoverCalendars } from '../lib/adapters/home-assistant.js';

const command = process.argv[2] || 'projection';
try {
  if (command === 'calendars') {
    // This explicit local command is the only place entity IDs are printed.
    process.stdout.write(`${JSON.stringify(await discoverCalendars(loadCalendarConnection()), null, 2)}\n`);
  } else if (command === 'projection' || command === 'fetch') {
    const config = await loadConfig();
    const runtime = new Runtime(config, { log: (level, fields) => process.stderr.write(`${JSON.stringify({ level, ...fields })}\n`) });
    await runtime.init();
    await runtime.refreshAll();
    const projection = runtime.snapshot();
    process.stdout.write(`${JSON.stringify(command === 'fetch' ? projection.health : projection, null, 2)}\n`);
    if (projection.health.some((h) => h.state !== 'ok')) process.exitCode = 1;
  } else {
    throw new Error('Usage: npm run cli -- projection|fetch|calendars');
  }
} catch {
  process.stderr.write('Dashboard command failed; check configuration and source health. No credentials were printed.\n');
  process.exitCode = 1;
}
