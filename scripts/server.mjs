import { loadConfig } from '../lib/config.js';
import { createDashboard } from '../lib/server.js';

try {
  const config = await loadConfig();
  const app = await createDashboard(config);
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(config.port, config.host, resolve);
  });
  app.log('info', { event: 'listening', port: app.server.address().port, demo: config.demo });
  app.runtime.refreshAll().catch(() => app.log('error', { event: 'initial_cache_persist_failed' }));
  app.runtime.start();
  app.observer.start();
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      const deadline = setTimeout(() => process.exit(1), 30000).unref();
      await app.close();
      clearTimeout(deadline);
    });
  }
} catch (error) {
  // Never print environment values or upstream response bodies.
  process.stderr.write(`${JSON.stringify({ level: 'error', event: 'startup_failed', code: error.name, message: 'Startup failed; check configuration, state permissions and listening address' })}\n`);
  process.exitCode = 1;
}
