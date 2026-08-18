import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createEngramServer } from '../server.js';
import { RemoteBackend } from '../backend-remote.js';

const tmp = mkdtempSync(join(tmpdir(), 'engram-remote-'));
const TOKEN = 'remote-test-token';
let backend: RemoteBackend;
let server: ReturnType<typeof createEngramServer>;

beforeAll(async () => {
  const port = 39000 + Math.floor(Math.random() * 1000);
  server = createEngramServer({
    port, host: '127.0.0.1', authToken: TOKEN,
    vaults: {}, defaultVault: { owner: 'remote-test', dbPath: join(tmp, 'v.db') },
  });
  await server.listen();
  backend = new RemoteBackend(`http://127.0.0.1:${port}`, TOKEN);
});
afterAll(async () => { await server.close(); rmSync(tmp, { recursive: true, force: true }); });

describe('RemoteBackend', () => {
  it('round-trips remember/recall/getById/stats/forget over REST', async () => {
    const mem = await backend.remember('global', { content: 'remote fixture: engram client mode' });
    expect(mem.id).toBeTruthy();

    const found = await backend.recall({ context: 'client mode', limit: 5 });
    expect(found.some(m => m.id === mem.id)).toBe(true);

    expect((await backend.getById(mem.id))?.content).toContain('remote fixture');
    expect((await backend.stats()).global.total).toBeGreaterThan(0);

    const gone = await backend.forget(mem.id, true);
    expect(gone.found).toBe(true);
    expect(await backend.getById(mem.id)).toBeNull();
  });

  it('rejects a bad token with a clear error', async () => {
    const bad = new RemoteBackend(backend['baseUrl'], 'wrong-token');
    await expect(bad.stats()).rejects.toThrow(/401|unauthorized/i);
  });
});
