import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Vault } from '../vault.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ============================================================
// Nickname fragmentation
// ============================================================
//
// Mnemis's base graph exists to collapse "San Francisco" / "SF" / "旧金山"
// into one node. Engram does the opposite: rule-based extraction writes every
// surface form as its own entity. Measured on the LoCoMo conv0 vault:
//   Melanie:265  Mel:58  Mell:1        <- one person, three entities
//   Caroline:339 Caro:2
//   LGBTQ:24     LGBT:1
// A query extracting "Melanie" therefore never reaches the 58 memories filed
// under "Mel", and co-entity spreading sees two unrelated hubs.
//
// Resolution here is deliberately conservative and deterministic: a strict
// case-insensitive prefix, both forms at least three characters, single-token
// only. That catches nicknames and acronym extensions without inventing
// semantic links.

function tmp(): string {
  return path.join(os.tmpdir(), `engram-alias-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe('entity alias resolution', () => {
  let vault: Vault;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmp();
    vault = new Vault({ owner: 'alias-test', dbPath });
    vault.remember({ content: 'Melanie took the kids to the pottery studio', entities: ['Melanie'] });
    vault.remember({ content: 'Mel signed up for the swimming class', entities: ['Mel'] });
    vault.remember({ content: 'Mell mentioned the camping trip', entities: ['Mell'] });
    vault.remember({ content: 'Caroline joined the LGBTQ support group', entities: ['Caroline', 'LGBTQ'] });
    vault.remember({ content: 'Caro spoke at the school', entities: ['Caro'] });
    vault.remember({ content: 'The LGBT parade was in June', entities: ['LGBT'] });
  });

  afterEach(() => {
    vault.close();
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + s); } catch {} }
  });

  it('links a nickname to its longer form in both directions', () => {
    expect(vault.resolveEntityAliases('Melanie').sort()).toEqual(['Mel', 'Melanie']);
    // "Mell" is a prefix-relative of "Mel", not of "Melanie" — the strings
    // diverge at index 3. It is reachable only by chaining Melanie -> Mel ->
    // Mell, and transitive prefix merging is precisely how unrelated entities
    // get chained together, so resolution is deliberately one hop.
    expect(vault.resolveEntityAliases('Mel').sort()).toEqual(['Mel', 'Melanie', 'Mell']);
  });

  it('links an acronym to its extension', () => {
    expect(vault.resolveEntityAliases('LGBTQ').sort()).toEqual(['LGBT', 'LGBTQ']);
  });

  it('is case-insensitive on the prefix', () => {
    expect(vault.resolveEntityAliases('caroline')).toContain('Caro');
  });

  it('never links two unrelated entities', () => {
    expect(vault.resolveEntityAliases('Melanie')).not.toContain('Caroline');
    expect(vault.resolveEntityAliases('Caroline')).not.toContain('LGBTQ');
  });

  it('refuses fragments shorter than three characters', () => {
    vault.remember({ content: 'Me and the dog', entities: ['Me'] });
    expect(vault.resolveEntityAliases('Melanie')).not.toContain('Me');
  });

  it('returns the input unchanged when nothing matches', () => {
    expect(vault.resolveEntityAliases('Nonexistent')).toEqual(['Nonexistent']);
  });

  it('reaches memories filed under the nickname', async () => {
    const hits = await vault.recallScored({ context: 'What activities does Melanie do', limit: 10 });
    const contents = hits.map(h => h.memory.content).join(' | ');
    expect(contents).toContain('swimming');
  });
});
