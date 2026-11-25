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
  assert.deepEqual(details.files, ['config.xml', 'dashboard-url.js', 'icon.png', 'index.html', 'lease.js', 'main.js']);
  assert.equal(details.application.package.length, 10);
  assert.equal(details.application.id, 'FrameHs001.Dashboard');
  const bytes = await fs.readFile(output);
  await packageTizen(`https://frame.example/display#token=${'x'.repeat(64)}`, output);
  assert.deepEqual(await fs.readFile(output), bytes);
  await assert.rejects(packageTizen('https://frame.example/display?k=secret', output));
  await assert.rejects(packageTizen('https://secret@frame.example/display#token=' + 'x'.repeat(64), output));
});

test('optional normal-shell telemetry is private, HTTPS-only and never enters the iframe address', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-telemetry-package-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'telemetry.wgt');
  const address = `https://frame.example/display#token=${'d'.repeat(32)}`;
  const telemetryToken = 't'.repeat(32);
  await packageTizen(address, output, { telemetryToken });
  const generated = execFileSync(process.env.PYTHON || 'python3', ['-c', `
import sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as z: print(z.read("dashboard-url.js").decode())
`, output], { encoding: 'utf8' });
  const [url, telemetry] = generated.trim().split('\n');
  assert.doesNotMatch(url, new RegExp(telemetryToken));
  assert.match(telemetry, new RegExp(telemetryToken));
  assert.match(telemetry, /https:\/\/frame\.example\/api\/brightness\/lease/);
  await assert.rejects(packageTizen(address, output, { telemetryToken: 'd'.repeat(32) }));
  await assert.rejects(packageTizen(address.replace('https:', 'http:'), output, { telemetryToken }));
  await assert.rejects(packageTizen(address, output, { telemetryToken: '' }));
  await packageTizen(address, output);
  const plain = execFileSync(process.env.PYTHON || 'python3', ['-c', `
import sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as z: print(z.read("dashboard-url.js").decode())
`, output], { encoding: 'utf8' });
  assert.match(plain, /window.BRIGHTNESS_TELEMETRY = null/);
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
