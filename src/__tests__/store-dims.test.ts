import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryStore } from '../store.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'engram-dims-'));
  dbPath = join(dir, 'v.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('embedding dimension guard', () => {
  it('records the dimension on first open', () => {
    const store = new MemoryStore(dbPath, 1536);
    expect(store.embeddingDims()).toBe(1536);
    store.close();
  });

  it('reopens cleanly at the same dimension', () => {
    new MemoryStore(dbPath, 1536).close();
    const store = new MemoryStore(dbPath, 1536);
    expect(store.embeddingDims()).toBe(1536);
    store.close();
  });

  it('refuses to open a 1536-dim vault as 3072', () => {
    new MemoryStore(dbPath, 1536).close();
    expect(() => new MemoryStore(dbPath, 3072)).toThrow(/1536/);
    expect(() => new MemoryStore(dbPath, 3072)).toThrow(/3072/);
  });

  it('still opens a vault with no embeddings at all', () => {
    const store = new MemoryStore(dbPath);
    expect(store.embeddingDims()).toBe(0);
    store.close();
  });

  it('allows adding embeddings to a vault that had none', () => {
    new MemoryStore(dbPath).close();
    const store = new MemoryStore(dbPath, 1536);
    expect(store.embeddingDims()).toBe(1536);
    store.close();
  });
});
