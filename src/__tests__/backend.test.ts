import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Vault } from '../vault.js';
import { MemoryRouter } from '../router.js';
import { localBackend, type EngramBackend } from '../backend.js';
import { HashEmbedder } from './helpers/hash-embedder.js';

const tmp = mkdtempSync(join(tmpdir(), 'engram-backend-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('localBackend', () => {
  it('exposes the router surface behind promises', async () => {
    const embedder = new HashEmbedder(64);
    const global = new Vault({ owner: 'g', dbPath: join(tmp, 'g.db') }, embedder);
    const project = new Vault({ owner: 'p', dbPath: join(tmp, 'p.db') }, embedder);
    const backend: EngramBackend = localBackend(new MemoryRouter(global, project));

    const mem = await backend.remember('global', 'Juan Carlos prefers explicit scopes');
    expect(mem.scope).toBe('global');

    const found = await backend.recall({ context: 'explicit scopes', limit: 5 });
    expect(found.some(m => m.id === mem.id)).toBe(true);

    const stats = await backend.stats();
    expect(stats.global.total).toBeGreaterThan(0);

    await backend.close();
  });
});
