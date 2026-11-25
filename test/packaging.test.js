import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { packageTizen, packageTizenProbe } from '../scripts/package-tizen.mjs';

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

test('offline probe is reproducible, unprivileged and excludes the live shell and credential', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-probe-package-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'probe.wgt');
  await packageTizenProbe(output);
  const details = JSON.parse(execFileSync(process.env.PYTHON || 'python3', ['-c', `
import json,sys,zipfile,xml.etree.ElementTree as ET
with zipfile.ZipFile(sys.argv[1]) as z:
    root=ET.fromstring(z.read("config.xml"))
    ns={"w":"http://www.w3.org/ns/widgets","t":"http://tizen.org/ns/widgets"}
    print(json.dumps({
        "files": sorted(z.namelist()),
        "application": root.find("t:application",ns).attrib,
        "content": root.find("w:content",ns).attrib,
        "privileges": len(root.findall("t:privilege",ns)),
        "access": len(root.findall("w:access",ns)),
        "html": z.read("probe.html").decode(),
    }))
`, output], { encoding: 'utf8' }));
  assert.deepEqual(details.files, ['config.xml', 'icon.png', 'probe.css', 'probe.html', 'probe.js']);
  assert.equal(details.application.id, 'FrameHs001.Dashboard');
  assert.equal(details.application.package, 'FrameHs001');
  assert.equal(details.content.src, 'probe.html');
  assert.equal(details.privileges, 0);
  assert.equal(details.access, 0);
  assert.match(details.html, /connect-src 'none'/);
  const bytes = await fs.readFile(output);
  await packageTizenProbe(output);
  assert.deepEqual(await fs.readFile(output), bytes);
  assert.equal((await fs.stat(output)).mode & 0o777, 0o600);
});
