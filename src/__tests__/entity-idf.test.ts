import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Vault } from '../vault.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ============================================================
// Entity boosts must be weighted by how rare the entity is
// ============================================================
//
// The old rule read `getByEntity(entity, 20).length` and stepped it through
// 0.25 / 0.15 / 0.1. Because the SQL carries LIMIT 20, that length saturates:
// an entity on 300 memories and an entity on 21 both return 20 and both scored
// 0.1, so the "fewer results = higher confidence" intent was unreachable for
// anything past the cap.
//
// This matters most in a real vault, where the owner's own name, employer and
// main project sit on nearly every memory. A term on 80% of the corpus carries
// almost no information — the same reason normaliseBm25 exists for text.

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `engram-idf-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe('entity boosts scale with inverse document frequency', () => {
  let vault: Vault;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    vault = new Vault({ owner: 'idf-test', dbPath });
    // "Caroline" is a hub: on every memory. "Oliver" is rare: on one.
    for (let i = 0; i < 40; i++) {
      vault.remember({ content: `Caroline wrote note number ${i}`, entities: ['Caroline'] });
    }
    vault.remember({ content: 'Caroline mentioned Oliver once', entities: ['Caroline', 'Oliver'] });
  });

  afterEach(() => {
    vault.close();
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + s); } catch {} }
  });

  it('counts true document frequency, not the truncated result set', () => {
    expect(vault.entityDocFrequency('Caroline')).toBe(41);
    expect(vault.entityDocFrequency('Oliver')).toBe(1);
  });

  it('gives a rare entity a much larger boost than a ubiquitous one', () => {
    const rare = vault.entityIdfWeight('Oliver');
    const hub = vault.entityIdfWeight('Caroline');
    expect(rare).toBeGreaterThan(hub * 3);
  });

  it('keeps every weight inside [0,1]', () => {
    for (const name of ['Caroline', 'Oliver', 'NeverSeen']) {
      const w = vault.entityIdfWeight(name);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
    }
  });

  it('does not divide by zero on an empty vault', () => {
    const p = tmpDbPath();
    const empty = new Vault({ owner: 'empty', dbPath: p });
    expect(Number.isFinite(empty.entityIdfWeight('anything'))).toBe(true);
    empty.close();
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(p + s); } catch {} }
  });
});
