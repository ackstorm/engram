import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Vault } from '../vault.js';
import type { Memory } from '../types.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `engram-graph-route-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanup(dbPath: string) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
}

// spreadDecay: 1 throughout — the default 0.5 puts one-hop activation within
// a few percent of minActivation (0.1) for this corpus, which is a flaky test
// rather than a meaningful default to assert on.
const QUERY = 'quarterly revenue';

describe('graphLimit — a reserved slice for graph-discovered memories', () => {
  let vault: Vault;
  let dbPath: string;
  let seed: Memory;
  let neighbour: Memory;

  beforeEach(() => {
    dbPath = tmpDbPath();
    // No embedder: BM25 alone is the primary retriever, which makes the test
    // deterministic and network-free. The graph route is unaffected by which
    // primary retriever seeded it.
    vault = new Vault({ owner: 'graph-route-test', dbPath });

    // The query is "quarterly revenue". The seed carries BOTH terms; the
    // competing filler notes carry only "quarterly", so the seed wins the
    // primary slice while the fillers still fill it. The rest of the corpus
    // carries neither, which keeps "quarterly" discriminating: a term present
    // in almost every memory drives SQLite's BM25 IDF to ~0, every hit lands
    // under BM25_NOISE_FLOOR, and Phase 1 returns nothing at all.
    seed = vault.remember({ content: 'The quarterly revenue review is on Friday', entities: ['Acme'] });
    // Shares no query term, so it can ONLY arrive through the edge.
    neighbour = vault.remember({ content: 'Marta signed off on the Basel numbers', entities: ['Acme'] });
    for (let i = 0; i < 6; i++) {
      vault.remember({ content: `Quarterly filler note number ${i}` });
    }
    for (let i = 0; i < 7; i++) {
      vault.remember({ content: `Unrelated note about logistics number ${i}` });
    }
    // Vault.connect(sourceId, targetId, type, strength) — src/vault.ts:1223.
    vault.connect(seed.id, neighbour.id, 'elaborates', 1.0);
  });

  afterEach(() => {
    vault.close();
    cleanup(dbPath);
  });

  it('omits graph-discovered memories from a full primary slice by default', async () => {
    const results = await vault.recallScored({ context: QUERY, limit: 5, spreadDecay: 1 });
    expect(results).toHaveLength(5);
    expect(results.map(r => r.memory.id)).not.toContain(neighbour.id);
  });

  it('appends them when graphLimit is set, without displacing the primary slice', async () => {
    const base = await vault.recallScored({ context: QUERY, limit: 5, spreadDecay: 1 });
    const withGraph = await vault.recallScored({ context: QUERY, limit: 5, graphLimit: 3, spreadDecay: 1 });

    // The first `limit` entries are exactly the ones the primary ranking chose.
    expect(withGraph.slice(0, 5).map(r => r.memory.id)).toEqual(base.map(r => r.memory.id));
    expect(withGraph.length).toBeGreaterThan(5);
    expect(withGraph.length).toBeLessThanOrEqual(8);
    expect(withGraph.map(r => r.memory.id)).toContain(neighbour.id);
  });

  it('never returns a memory twice', async () => {
    const results = await vault.recallScored({ context: QUERY, limit: 5, graphLimit: 10, spreadDecay: 1 });
    const ids = results.map(r => r.memory.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('respects the graph budget as a hard cap', async () => {
    const results = await vault.recallScored({ context: QUERY, limit: 2, graphLimit: 1, spreadDecay: 1 });
    expect(results.length).toBeLessThanOrEqual(3);
  });
});
