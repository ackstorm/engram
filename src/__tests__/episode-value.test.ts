import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseEpisodeValues } from '../vault.js';
import { MemoryStore } from '../store.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ============================================================
// The dream assigns value; nothing else can
// ============================================================
//
// Salience is auto-assigned by keyword heuristics and barely varies: on a
// LoCoMo vault, 259 of 419 episodes (62%) sit at exactly 0.3. Retrieval reads
// salience in step 8 and decay/archival read stability, so both consume a
// signal that cannot discriminate — which is why a vault cannot "keep the good
// and drop the spurious". Consolidation is the one pass that reads every
// memory in context, so it is where a real value judgement can come from.

describe('parseEpisodeValues', () => {
  it('maps episode numbers to salience, one-indexed as the prompt presents them', () => {
    const out = parseEpisodeValues('{"episode_values": [{"episode": 1, "salience": 0.9}, {"episode": 3, "salience": 0.1}]}', 3);
    expect(out.get(0)).toBeCloseTo(0.9);
    expect(out.get(2)).toBeCloseTo(0.1);
    expect(out.has(1)).toBe(false);
  });

  it('ignores episode numbers outside the batch', () => {
    const out = parseEpisodeValues('{"episode_values": [{"episode": 0, "salience": 0.5}, {"episode": 99, "salience": 0.5}]}', 3);
    expect(out.size).toBe(0);
  });

  it('clamps out-of-range values instead of trusting them', () => {
    const out = parseEpisodeValues('{"episode_values": [{"episode": 1, "salience": 4}, {"episode": 2, "salience": -2}]}', 2);
    expect(out.get(0)).toBe(1);
    expect(out.get(1)).toBe(0);
  });

  it('survives junk without throwing', () => {
    for (const raw of ['not json', '{}', '{"episode_values": "nope"}', '{"episode_values": [null, 3]}']) {
      expect(parseEpisodeValues(raw, 3).size).toBe(0);
    }
  });

  it('tolerates prose wrapped around the JSON', () => {
    const out = parseEpisodeValues('Sure!\n```json\n{"episode_values": [{"episode": 2, "salience": 0.7}]}\n```', 2);
    expect(out.get(1)).toBeCloseTo(0.7);
  });
});

describe('MemoryStore.updateSalience', () => {
  let store: MemoryStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `engram-sal-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    store = new MemoryStore(dbPath);
  });

  afterEach(() => {
    store.close();
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + s); } catch {} }
  });

  function seed(id: string) {
    const now = new Date(0).toISOString();
    store.insertMemoryVerbatim({
      id, content: `memory ${id}`, summary: '', type: 'episodic', entities: [], topics: [],
      salience: 0.3, confidence: 0.9, stability: 1, status: 'active',
      createdAt: now, updatedAt: now, lastAccessedAt: now, lastModifiedAt: now,
      accessCount: 0, agentId: 'test', visibility: 'private',
      source: { type: 'manual', timestamp: now },
    } as never);
    return id;
  }

  it('persists a revised salience', () => {
    seed('m1');
    store.updateSalience('m1', 0.85);
    expect(store.getMemoryDirect('m1')!.salience).toBeCloseTo(0.85);
  });

  it('clamps to [0,1]', () => {
    seed('m2');
    store.updateSalience('m2', 5);
    expect(store.getMemoryDirect('m2')!.salience).toBe(1);
    store.updateSalience('m2', -3);
    expect(store.getMemoryDirect('m2')!.salience).toBe(0);
  });
});
