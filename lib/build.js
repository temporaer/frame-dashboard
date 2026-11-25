import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export async function buildIdentity(directory) {
  const hash = createHash('sha256');
  async function visit(relative) {
    const entries = await fs.readdir(path.join(directory, relative), { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) hash.update(name).update('\0').update(await fs.readFile(path.join(directory, name))).update('\0');
    }
  }
  await visit('');
  return hash.digest('hex').slice(0, 16);
}
