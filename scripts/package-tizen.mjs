import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
export async function packageTizen(address, output = path.join(ROOT, 'tizen/HouseholdFrame.unsigned.wgt')) {
  const url = new URL(address);
  const token = new URLSearchParams(url.hash.slice(1)).get('token');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/display' || url.search || !token || token.length < 32) {
    throw new Error('DASHBOARD_URL must be an HTTP(S) /display URL with only a scoped #token= fragment');
  }
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'household-frame-wgt-'));
  try {
    for (const name of ['index.html', 'main.js', 'icon.png']) {
      await fs.copyFile(path.join(ROOT, 'tizen', name), path.join(stage, name));
    }
    const manifest = await fs.readFile(path.join(ROOT, 'tizen/config.xml'), 'utf8');
    await fs.writeFile(path.join(stage, 'config.xml'), manifest.replace('<access origin="*"', `<access origin="${url.origin}"`));
    await fs.writeFile(path.join(stage, 'dashboard-url.js'), `window.DASHBOARD_URL = ${JSON.stringify(url.toString())};\n`, { mode: 0o600 });
    await fs.mkdir(path.dirname(output), { recursive: true });
    execFileSync(process.env.PYTHON || 'python3', ['-c', `
import pathlib,sys,zipfile
with zipfile.ZipFile(sys.argv[1], "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for name in sorted(sys.argv[2:]):
        info=zipfile.ZipInfo(name, (1980,1,1,0,0,0))
        info.compress_type=zipfile.ZIP_DEFLATED
        info.external_attr=0o100600 << 16
        archive.writestr(info, pathlib.Path(name).read_bytes())
`, output, 'config.xml', 'index.html', 'main.js', 'icon.png', 'dashboard-url.js'], { cwd: stage });
    await fs.chmod(output, 0o600);
    return output;
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  try {
    const output = await packageTizen(process.env.DASHBOARD_URL);
    process.stdout.write(`Unsigned widget: ${output}\nTreat it as private: it contains the scoped display credential.\n`);
  } catch {
    process.stderr.write('Tizen packaging failed. Set DASHBOARD_URL to your /display#token= URL and ensure Python 3 is available.\n');
    process.exitCode = 1;
  }
}
