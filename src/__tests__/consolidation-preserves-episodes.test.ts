import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Vault } from '../vault.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ============================================================
// A dream must not delete what it summarised
// ============================================================
//
// consolidate() used to mark every consolidated episode 'superseded'. Since
// recallScored filters superseded memories out by default, one dream made the
// entire episodic layer unretrievable: measured on a LoCoMo vault, 419 active
// memories became 11, and retrieval recall went from 0.888 to 0.000.
//
// The dream scheduler runs this every 24 hours by default, so the loss was
// automatic and silent. Summaries are an ADDITIONAL layer of granularity, not
// a replacement: the summary carries connective tissue across turns, the raw
// turn carries the detail, and questions need both.

function tmp(): string {
  return path.join(os.tmpdir(), `engram-dream-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe('consolidation preserves the episodes it consolidates', () => {
  let vault: Vault;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmp();
    // No LLM: consolidate() takes the rule-based path, which is the one that
    // ships when a user has no model configured.
    vault = new Vault({ owner: 'dream-test', dbPath });
    // Distinct content: near-identical memories are deduplicated at
    // remember() time, which would leave far fewer than 12 to retrieve and
    // make the assertions below measure dedup rather than consolidation.
    const facts = [
      'Marta approved the billing migration plan on Tuesday',
      'Marta moved the billing cutover to the Basel region',
      'Marta asked for a rollback window during billing changes',
      'The billing migration needs a schema freeze first',
      'Billing invoices were double counted before the migration',
      'Marta briefed finance about billing downtime',
      'The billing migration dry run finished overnight',
      'Marta wants billing metrics dashboards before cutover',
      'Legal signed off on the billing data transfer',
      'The billing migration rollback script was tested',
      'Marta scheduled the billing freeze for month end',
      'Support was warned about billing migration tickets',
    ];
    for (const content of facts) vault.remember({ content, entities: ['Marta'] });
  });

  afterEach(() => {
    vault.close();
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + s); } catch {} }
  });

  it('leaves every episode active after a dream', async () => {
    const activeBefore = vault.byStatus('active', 200).length;
    expect(activeBefore).toBeGreaterThanOrEqual(12);

    await vault.consolidate({ all: true });

    // Consolidation may ADD memories; it must never retire what it read.
    expect(vault.byStatus('active', 200).length).toBeGreaterThanOrEqual(activeBefore);
  });

  it('keeps a specific episode retrievable after a dream', async () => {
    // Queried on a term unique to one memory. A term shared by most of the
    // corpus drives SQLite's BM25 IDF to ~0, every hit lands under
    // BM25_NOISE_FLOOR, and the query returns nothing for reasons that have
    // nothing to do with consolidation.
    const q = 'legal signed off data transfer';
    const before = await vault.recallScored({ context: q, limit: 50 });
    expect(before.some(r => r.memory.content.includes('Legal signed off'))).toBe(true);

    await vault.consolidate({ all: true });

    const after = await vault.recallScored({ context: q, limit: 50 });
    expect(after.some(r => r.memory.content.includes('Legal signed off'))).toBe(true);
  });

  it('does not supersede episodic memories as a side effect', async () => {
    await vault.consolidate({ all: true });
    const stats = await vault.stats();
    expect(stats.total).toBeGreaterThanOrEqual(12);
    const superseded = vault.byStatus('superseded', 100);
    expect(superseded.filter(m => m.type === 'episodic')).toHaveLength(0);
  });

  it('is safe to dream repeatedly', async () => {
    await vault.consolidate({ all: true });
    await vault.consolidate({ all: true });
    await vault.consolidate({ all: true });
    const after = await vault.recallScored({ context: 'billing migration', limit: 50 });
    expect(after.length).toBeGreaterThan(5);
  });
});
