import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Vault } from '../vault.js';
import { HashEmbedder } from './helpers/hash-embedder.js';
import type { VaultConfig } from '../types.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `engram-vec-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanup(dbPath: string) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
}

describe('Vector Search with a stub embedder', () => {
  let vault: Vault;
  let dbPath: string;
  let embedder: HashEmbedder;

  beforeEach(() => {
    dbPath = tmpDbPath();
    embedder = new HashEmbedder(128);
    vault = new Vault(
      {
        owner: 'vec-test',
        dbPath,
        agentId: 'test-agent',
      },
      embedder,
    );
  });

  afterEach(() => {
    vault.close();
    cleanup(dbPath);
  });

  it('stores memories with embeddings and recalls via vector search', async () => {
    // Store memories and wait for embeddings
    const m1 = vault.remember({
      content: 'React is a JavaScript library for building user interfaces',
      topics: ['frontend', 'react'],
    });
    const m2 = vault.remember({
      content: 'PostgreSQL is a relational database management system',
      topics: ['backend', 'database'],
    });
    const m3 = vault.remember({
      content: 'TypeScript adds static typing to JavaScript for better developer experience',
      topics: ['frontend', 'typescript'],
    });

    // Wait for async embedding computation
    await vault.computeAndStoreEmbedding(m1.id, m1.content);
    await vault.computeAndStoreEmbedding(m2.id, m2.content);
    await vault.computeAndStoreEmbedding(m3.id, m3.content);

    // Recall something related to frontend JavaScript
    const results = await vault.recall('JavaScript frontend development');

    expect(results.length).toBeGreaterThan(0);
    // React and TypeScript memories should score higher than PostgreSQL
    const contents = results.map(r => r.content);
    expect(contents.some(c => c.includes('React') || c.includes('TypeScript'))).toBe(true);
  });

  it('backfills embeddings for existing memories', async () => {
    vault.remember('Memory without embedding 1');
    vault.remember('Memory without embedding 2');
    vault.remember('Memory without embedding 3');

    const count = await vault.backfillEmbeddings();
    expect(count).toBe(3);

    // Should now be searchable via vectors
    const results = await vault.recall('embedding memory');
    expect(results.length).toBeGreaterThan(0);
  });

  it('produces consistent vectors for same input', async () => {
    const text = 'Hello world test';
    const v1 = await embedder.embed(text);
    const v2 = await embedder.embed(text);

    expect(v1).toEqual(v2);
    expect(v1.length).toBe(128);
  });

  // The defect that got LocalEmbeddings deleted: it assigned vector slots in
  // first-seen order and held the mapping in memory, so a fresh process
  // embedded the same text to an orthogonal vector (cosine 0.000) and every
  // vector already in the vault became noise.
  it('embeds identically from a fresh instance, whatever it saw first', async () => {
    const warmed = new HashEmbedder(128);
    await warmed.embed('completely unrelated preamble about kubernetes');

    const text = 'the deploy pipeline uses argocd';
    const fromFresh = await new HashEmbedder(128).embed(text);
    const fromWarmed = await warmed.embed(text);

    expect(fromWarmed).toEqual(fromFresh);
  });

  it('produces unit vectors', async () => {
    const vec = await embedder.embed('Some test text for normalization check');
    const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    expect(magnitude).toBeCloseTo(1.0, 5);
  });

  it('embedBatch handles multiple inputs', async () => {
    const vecs = await embedder.embedBatch(['hello world', 'goodbye world', 'test input']);
    expect(vecs.length).toBe(3);
    expect(vecs[0].length).toBe(128);
  });

  it('falls back gracefully when embeddings fail', async () => {
    // Vault without embedder should still work via keyword search
    const noVecDbPath = tmpDbPath();
    const noVecVault = new Vault({
      owner: 'no-vec-test',
      dbPath: noVecDbPath,
    });

    noVecVault.remember('Simple memory for fallback test');
    const results = await noVecVault.recall('fallback test');
    expect(results.length).toBeGreaterThan(0);

    noVecVault.close();
    cleanup(noVecDbPath);
  });
});
