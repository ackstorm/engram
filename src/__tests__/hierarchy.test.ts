import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryStore } from '../store.js';
import { buildHierarchy, selectByTraversal } from '../hierarchy.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `engram-hierarchy-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe('buildHierarchy', () => {
  let store: MemoryStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    store = new MemoryStore(dbPath);
    // Layer 0 is the entities table. upsertEntity is the existing accessor
    // (src/store.ts:762); getAllEntityNames sorts, so the indices the prompt
    // uses are: 0 Caroline, 1 Melanie, 2 Sweden, 3 camping, 4 pottery.
    for (const name of ['pottery', 'camping', 'Sweden', 'Melanie', 'Caroline']) {
      store.upsertEntity(name);
    }
  });

  afterEach(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + suffix); } catch {}
    }
  });

  it('builds one layer above the entities', async () => {
    const chat = async () => JSON.stringify({
      categories: [
        { name: 'Hobbies', tags: ['leisure', 'free time'], children: [0, 1] },
        { name: 'Speaker', tags: ['the user'], children: [2, 3, 4] },
      ],
    });
    const out = await buildHierarchy(store, chat, { maxLayers: 1, minChildren: 2 });
    expect(out.layers).toBe(1);
    expect(out.categories).toBe(2);
    expect(store.getCategoriesByLayer(1).map(c => c.name).sort()).toEqual(['Hobbies', 'Speaker']);
  });

  it('maps children by index, not by name', async () => {
    const entities = store.getAllEntityNames();
    const chat = async () => JSON.stringify({
      categories: [{ name: 'Everything', tags: ['all'], children: entities.map((_, i) => i) }],
    });
    await buildHierarchy(store, chat, { maxLayers: 1, minChildren: 1 });
    const cat = store.getCategoriesByLayer(1)[0];
    const kids = store.getCategoryChildren([cat.id]);
    expect(kids.map(k => k.childId).sort()).toEqual([...entities].sort());
    expect(kids.every(k => k.childKind === 'entity')).toBe(true);
  });

  it('rejects a category name containing "and" as a connector', async () => {
    const chat = async () => JSON.stringify({
      categories: [
        { name: 'Food and Drinks', tags: ['meals'], children: [0] },
        { name: 'Travel', tags: ['places'], children: [1] },
      ],
    });
    await buildHierarchy(store, chat, { maxLayers: 1, minChildren: 1 });
    expect(store.getCategoriesByLayer(1).map(c => c.name)).toEqual(['Travel']);
  });

  it('stops when a layer fails to compress', async () => {
    const entities = store.getAllEntityNames();
    // One category per entity: the layer above is no smaller than the one
    // below, which violates the compression constraint.
    const chat = async () => JSON.stringify({
      categories: entities.map((e, i) => ({ name: `Cat${i}`, tags: [e], children: [i] })),
    });
    const out = await buildHierarchy(store, chat, { maxLayers: 4, minChildren: 1 });
    expect(out.layers).toBe(0);
    expect(store.getCategoriesByLayer(1)).toEqual([]);
  });

  it('is idempotent — a rebuild replaces, never appends', async () => {
    const chat = async () => JSON.stringify({
      categories: [{ name: 'Hobbies', tags: ['leisure'], children: [0, 1] }],
    });
    await buildHierarchy(store, chat, { maxLayers: 1, minChildren: 1 });
    await buildHierarchy(store, chat, { maxLayers: 1, minChildren: 1 });
    expect(store.getCategoriesByLayer(1)).toHaveLength(1);
  });

  it('survives unparseable model output without throwing', async () => {
    const chat = async () => 'I am afraid I cannot do that';
    const out = await buildHierarchy(store, chat, { maxLayers: 2, minChildren: 1 });
    expect(out).toEqual({ layers: 0, categories: 0 });
  });
});

describe('selectByTraversal', () => {
  let store: MemoryStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `engram-traverse-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    store = new MemoryStore(dbPath);
    // Layer 1: two categories over four entities.
    store.insertCategory({ id: 'c-hobbies', name: 'Hobbies', tags: ['leisure'], layer: 1 });
    store.insertCategory({ id: 'c-places', name: 'Places', tags: ['geography'], layer: 1 });
    store.linkCategoryChild('c-hobbies', 'pottery', 'entity');
    store.linkCategoryChild('c-hobbies', 'camping', 'entity');
    store.linkCategoryChild('c-places', 'Sweden', 'entity');
    store.linkCategoryChild('c-places', 'Boston', 'entity');
  });

  afterEach(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + suffix); } catch {}
    }
  });

  it('returns the entities under the categories the model selects', async () => {
    const chat = async () => JSON.stringify({ selected: [{ name: 'Hobbies', get_all_children: false }] });
    expect((await selectByTraversal(store, 'what does she do for fun', chat)).sort())
      .toEqual(['camping', 'pottery']);
  });

  it('takes every descendant when get_all_children is set', async () => {
    const chat = async () => JSON.stringify({ selected: [{ name: 'Places', get_all_children: true }] });
    expect((await selectByTraversal(store, 'where has she been', chat)).sort())
      .toEqual(['Boston', 'Sweden']);
  });

  it('returns nothing when the model selects nothing', async () => {
    const chat = async () => JSON.stringify({ selected: [] });
    expect(await selectByTraversal(store, 'unrelated', chat)).toEqual([]);
  });

  it('returns nothing, without throwing, when there is no hierarchy', async () => {
    store.clearCategories();
    const chat = async () => JSON.stringify({ selected: [{ name: 'Hobbies', get_all_children: true }] });
    expect(await selectByTraversal(store, 'anything', chat)).toEqual([]);
  });

  it('survives unparseable model output', async () => {
    const chat = async () => 'sorry, no';
    expect(await selectByTraversal(store, 'anything', chat)).toEqual([]);
  });

  it('ignores names the model invents', async () => {
    const chat = async () => JSON.stringify({ selected: [{ name: 'Nonexistent', get_all_children: true }] });
    expect(await selectByTraversal(store, 'anything', chat)).toEqual([]);
  });
});
