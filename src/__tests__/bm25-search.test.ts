import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryStore } from '../store.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let dir: string;
let store: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'engram-bm25-'));
  store = new MemoryStore(join(dir, 'v.db'));
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe('BM25 search', () => {
  it('ranks a focused match above a diluted one', () => {
    store.createMemory({ content: 'pnpm is the package manager here' } as any);
    store.createMemory({
      content: 'a long note about deployment, CI, testing, linting, releases, ' +
               'docker, kubernetes and incidentally pnpm somewhere near the end',
    } as any);
    const hits = store.searchBM25('pnpm', 10);
    expect(hits.length).toBe(2);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    expect(store.getMemoryDirect(hits[0].id)!.content).toContain('package manager');
  });

  it('down-weights terms that appear in every document', () => {
    for (let i = 0; i < 5; i++) {
      store.createMemory({ content: `the deploy pipeline step ${i}` } as any);
    }
    store.createMemory({ content: 'the deploy pipeline uses argocd exclusively' } as any);
    const hits = store.searchBM25('argocd deploy', 10);
    expect(store.getMemoryDirect(hits[0].id)!.content).toContain('argocd');
  });

  it('indexes memories created after the table exists', () => {
    store.createMemory({ content: 'freshly written memory about kafka' } as any);
    expect(store.searchBM25('kafka', 10).length).toBe(1);
  });

  it('reflects deletions', () => {
    const m = store.createMemory({ content: 'ephemeral memory about redis' } as any);
    expect(store.searchBM25('redis', 10).length).toBe(1);
    store.deleteMemory(m.id);
    expect(store.searchBM25('redis', 10).length).toBe(0);
  });

  it('returns nothing for an empty query', () => {
    store.createMemory({ content: 'anything at all' } as any);
    expect(store.searchBM25('', 10)).toEqual([]);
  });

  it('survives FTS5 punctuation without throwing', () => {
    store.createMemory({ content: 'a memory' } as any);
    expect(() => store.searchBM25('what is "this" AND (that)?', 10)).not.toThrow();
  });
});
