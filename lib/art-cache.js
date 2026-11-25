import fs from 'node:fs/promises';
import path from 'node:path';
import { REMOTE_ART } from './art.js';

export class ArtworkCache {
  constructor(config) {
    this.dir = path.join(config.dataDir, 'artwork');
    this.limit = config.presentation.artworkCacheMB * 1024 * 1024;
    this.pending = new Map();
  }

  async get(id) {
    if (!REMOTE_ART.has(id)) throw new Error('artwork_unknown');
    const file = path.join(this.dir, id);
    try { return await fs.readFile(file); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (this.pending.has(id)) return this.pending.get(id);
    const work = this.download(id, file).finally(() => this.pending.delete(id));
    this.pending.set(id, work);
    return work;
  }

  async download(id, file) {
    const response = await fetch(REMOTE_ART.get(id), { redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) throw new Error('artwork_fetch_failed');
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 24 * 1024 * 1024) throw new Error('artwork_too_large');
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks);
    const jpeg = data[0] === 0xff && data[1] === 0xd8;
    const png = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (!jpeg && !png) throw new Error('artwork_format_unsupported');
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(`${file}.tmp`, data, { mode: 0o600 });
    await fs.rename(`${file}.tmp`, file);
    const entries = await Promise.all((await fs.readdir(this.dir)).filter((n) => /^[a-f0-9]{64}$/.test(n)).map(async (name) => {
      const stat = await fs.stat(path.join(this.dir, name));
      return { name, size: stat.size, at: stat.mtimeMs };
    }));
    let total = entries.reduce((sum, e) => sum + e.size, 0);
    for (const entry of entries.sort((a, b) => a.at - b.at)) {
      if (total <= this.limit) break;
      if (entry.name !== id) {
        await fs.unlink(path.join(this.dir, entry.name));
        total -= entry.size;
      }
    }
    return data;
  }
}
