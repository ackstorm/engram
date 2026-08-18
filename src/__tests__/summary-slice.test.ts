import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Vault } from '../vault.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ============================================================
// Summaries supplement the episodic budget, they do not displace it
// ============================================================
//
// Consolidation writes semantic memories whose source.type is 'consolidation'.
// Those competed with raw turns for the same top-k slots and won, because step
// 8 grants semantic memories a 0.25 type bonus. Measured on a LoCoMo vault:
// 107 summaries alongside 419 turns dropped e2e accuracy from 84.9% to 80.3%
// and multi-hop from 62.5 to 46.9 — questions asked for the turn holding a
// fact and received a summary of it.
//
// summaryLimit reserves slots for them instead, the same shape graphLimit uses
// for unranked graph candidates: consolidation output is additional context,
// never a substitute for the evidence it was derived from.

function tmp(): string {
  return path.join(os.tmpdir(), `engram-summary-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe('summaryLimit reserves slots for consolidation output', () => {
  let vault: Vault;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmp();
    vault = new Vault({ owner: 'summary-test', dbPath });
    const turns = [
      'Marta approved the billing migration plan on Tuesday',
      'Marta moved the billing cutover to the Basel region',
      'Marta asked for a rollback window during billing changes',
      'The billing migration needs a schema freeze first',
      'Billing invoices were double counted before the migration',
      'Marta briefed finance about billing downtime',
    ];
    for (const content of turns) vault.remember({ content, entities: ['Marta'] });
    // Stand in for consolidation output.
    for (let i = 0; i < 4; i++) {
      vault.remember({
        content: `Summary ${i}: Marta is driving the billing migration to Basel`,
        type: 'semantic',
        entities: ['Marta'],
        source: { type: 'consolidation', evidence: [] },
      });
    }
  });

  afterEach(() => {
    vault.close();
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + s); } catch {} }
  });

  const isSummary = (m: { type: string; source?: { type?: string } }) =>
    m.type === 'semantic' && m.source?.type === 'consolidation';

  it('defaults to off, leaving ranking exactly as before', async () => {
    const a = await vault.recallScored({ context: 'billing migration Basel', limit: 5 });
    const b = await vault.recallScored({ context: 'billing migration Basel', limit: 5, summaryLimit: 0 });
    expect(a.map(r => r.memory.id)).toEqual(b.map(r => r.memory.id));
  });

  it('places every summary after every episode, never interleaved', async () => {
    const res = await vault.recallScored({ context: 'billing migration Basel', limit: 4, summaryLimit: 2 });
    // The contract is a partition, not "absent from the first `limit`": when
    // fewer non-summary results exist than `limit`, summaries legitimately
    // occupy positions inside that window. What must never happen is an
    // episode ranked below a summary.
    const firstSummary = res.findIndex(r => isSummary(r.memory));
    if (firstSummary >= 0) {
      expect(res.slice(firstSummary).every(r => isSummary(r.memory))).toBe(true);
    }
  });

  it('appends summaries after the primary slice, within the reserve', async () => {
    const res = await vault.recallScored({ context: 'billing migration Basel', limit: 4, summaryLimit: 2 });
    const summaries = res.filter(r => isSummary(r.memory));
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries.length).toBeLessThanOrEqual(2);
    expect(res.length).toBeLessThanOrEqual(6);
  });

  it('never returns a memory twice', async () => {
    const res = await vault.recallScored({ context: 'billing migration Basel', limit: 4, summaryLimit: 4 });
    const ids = res.map(r => r.memory.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
