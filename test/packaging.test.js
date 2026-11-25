import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { packageTizen } from '../scripts/package-tizen.mjs';

test('headless WGT preserves fixed identity and excludes repository secrets', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-package-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'test.wgt');
  await packageTizen(`https://frame.example/display#token=${'x'.repeat(64)}`, output);
  const details = JSON.parse(execFileSync(process.env.PYTHON || 'python3', ['-c', `
import json,sys,zipfile,xml.etree.ElementTree as ET
with zipfile.ZipFile(sys.argv[1]) as z:
    root=ET.fromstring(z.read("config.xml"))
    application=root.find("{http://tizen.org/ns/widgets}application")
    print(json.dumps({"files": sorted(z.namelist()), "application": application.attrib}))
`, output], { encoding: 'utf8' }));
  assert.deepEqual(details.files, ['config.xml', 'dashboard-url.js', 'icon.png', 'index.html', 'main.js']);
  assert.equal(details.application.package.length, 10);
  assert.equal(details.application.id, 'FrameHs001.Dashboard');
  const bytes = await fs.readFile(output);
  await packageTizen(`https://frame.example/display#token=${'x'.repeat(64)}`, output);
  assert.deepEqual(await fs.readFile(output), bytes);
  await assert.rejects(packageTizen('https://frame.example/display?k=secret', output));
  await assert.rejects(packageTizen('https://secret@frame.example/display#token=' + 'x'.repeat(64), output));
});
