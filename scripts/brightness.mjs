import fs from 'node:fs/promises';
import { parseBrightness, brightnessConnection } from '../lib/brightness-config.js';
import { BrightnessObserver } from '../lib/brightness-observer.js';

let observer;
try {
  if (process.argv.length > 2) throw new Error('brightness_cli_has_no_arguments');
  const file = JSON.parse(await fs.readFile(process.env.DASHBOARD_CONFIG, 'utf8'));
  const brightness = parseBrightness(file.brightness);
  if (!brightness.enabled) throw new Error('brightness_observer_disabled');
  observer = new BrightnessObserver(brightnessConnection(process.env, brightness));
  await observer.refresh();
  const status = observer.status();
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  if (status.error) process.exitCode = 1;
} catch {
  process.stderr.write('Brightness observation failed; check non-demo HA connection and brightness configuration. No credentials were printed.\n');
  process.exitCode = 1;
} finally {
  await observer?.close();
}
