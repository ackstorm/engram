import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Vault } from '../vault.js';
import { MemoryRouter } from '../router.js';

let dir: string;
let router: MemoryRouter;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'engram-router-'));
  const global = new Vault({ owner: 'g', dbPath: join(dir, 'global.db') });
  const project = new Vault({ owner: 'p', dbPath: join(dir, 'project.db') });
  router = new MemoryRouter(global, project);
});
afterEach(async () => {
  await router.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('targeted writes', () => {
  it('routes a global write to the global store only', async () => {
    router.remember('global', { content: 'Prefers TypeScript', type: 'profile' });
    const g = await router.recall({ context: 'TypeScript', scope: 'global' });
    const p = await router.recall({ context: 'TypeScript', scope: 'project' });
    expect(g.length).toBe(1);
    expect(p.length).toBe(0);
  });

  it('routes a project write to the project store only', async () => {
    router.remember('project', { content: 'This repo uses pnpm', type: 'semantic' });
    expect((await router.recall({ context: 'pnpm', scope: 'project' })).length).toBe(1);
    expect((await router.recall({ context: 'pnpm', scope: 'global' })).length).toBe(0);
  });
});

describe('merged reads', () => {
  beforeEach(() => {
    router.remember('global', { content: 'Always run the linter before committing', type: 'procedural' });
    router.remember('project', { content: 'Run the linter with pnpm lint in this repo', type: 'procedural' });
  });

  it('reads both stores by default', async () => {
    const results = await router.recall({ context: 'linter' });
    expect(results.length).toBe(2);
    expect(new Set(results.map(r => r.scope))).toEqual(new Set(['global', 'project']));
  });

  it('labels every result with its store', async () => {
    for (const r of await router.recall({ context: 'linter' })) {
      expect(['global', 'project']).toContain(r.scope);
    }
  });

  it('narrows when scope is given', async () => {
    const g = await router.recall({ context: 'linter', scope: 'global' });
    expect(g.length).toBe(1);
    expect(g[0].scope).toBe('global');
  });

  it('applies limit AFTER merging, not per store', async () => {
    const results = await router.recall({ context: 'linter', limit: 1 });
    expect(results.length).toBe(1);
  });
});

describe('cross-store identity', () => {
  it('finds a memory by id in either store', () => {
    const g = router.remember('global', { content: 'global thing' });
    const p = router.remember('project', { content: 'project thing' });
    expect(router.getById(g.id)?.scope).toBe('global');
    expect(router.getById(p.id)?.scope).toBe('project');
  });

  it('forgets from whichever store holds it', () => {
    const p = router.remember('project', { content: 'to be forgotten' });
    expect(router.forget(p.id, true).found).toBe(true);
    expect(router.getById(p.id)).toBeNull();
  });

  it('returns null for an unknown id', () => {
    expect(router.getById('m_nonexistent')).toBeNull();
  });
});

describe('stats and entities', () => {
  it('reports stats per scope', () => {
    router.remember('global', { content: 'one global memory' });
    router.remember('project', { content: 'one project memory' });
    router.remember('project', { content: 'another project memory' });
    const s = router.stats();
    expect(s.global.total).toBe(1);
    expect(s.project!.total).toBe(2);
  });

  it('merges entities by name and sums counts', () => {
    router.remember('global', { content: 'Marta leads SRE', entities: ['Marta'] });
    router.remember('project', { content: 'Marta reviewed the deploy', entities: ['Marta'] });
    const marta = router.entities().find(e => e.name === 'Marta');
    expect(marta).toBeDefined();
    expect(marta!.memoryCount).toBe(2);
  });
});
