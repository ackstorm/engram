import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore } from '../store.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'engram-schema-'));
  dbPath = join(dir, 'v.db');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('profile type', () => {
  it('accepts a profile memory in a fresh vault', () => {
    const store = new MemoryStore(dbPath);
    const m = store.createMemory({
      content: 'Prefers TypeScript and concise answers',
      type: 'profile',
      entities: ['Juan Carlos'],
      topics: ['preferences'],
    } as any);
    expect(m.type).toBe('profile');
    expect(store.getMemoryDirect(m.id)?.type).toBe('profile');
    store.close();
  });

  it('migrates an existing 3-type vault and preserves every row', () => {
    // Build a vault, write one of each old type, close it.
    const store = new MemoryStore(dbPath);
    const ids = (['episodic', 'semantic', 'procedural'] as const).map(t =>
      store.createMemory({ content: `a ${t} memory`, type: t } as any).id,
    );
    // An edge, to prove foreign keys survive the rebuild.
    store.createEdge(ids[0], ids[1], 'supports', 0.7);
    store.close();

    // Reopen — migration runs.
    const reopened = new MemoryStore(dbPath);
    for (const id of ids) expect(reopened.getMemoryDirect(id)).not.toBeNull();
    expect(reopened.getEdgesForMemories([ids[0]]).length).toBe(1);

    // And profile now works on the migrated vault.
    const p = reopened.createMemory({ content: 'likes dark mode', type: 'profile' } as any);
    expect(p.type).toBe('profile');
    reopened.close();
  });

  it('is idempotent — reopening twice does not rebuild again', () => {
    new MemoryStore(dbPath).close();
    new MemoryStore(dbPath).close();
    const db = new DatabaseSync(dbPath);
    const v = db.prepare(`SELECT value FROM engram_meta WHERE key='schema_version'`).get() as any;
    expect(v.value).toBe('2');
    db.close();
  });

  it('leaves no CHECK constraint on type', () => {
    new MemoryStore(dbPath).close();
    const db = new DatabaseSync(dbPath);
    const row = db.prepare(`SELECT sql FROM sqlite_master WHERE name='memories'`).get() as any;
    expect(row.sql).not.toContain('CHECK(type');
    db.close();
  });
});
