// ============================================================
// Retrieval quality benchmark
// ============================================================
//
// Usage:
//   MODEL_PROVIDER=openai OPENAI_API_KEY=… OPENAI_BASE_URL=https://host \
//   ENGRAM_EMBEDDING_MODEL=text-embedding-3-small \
//   npx tsx eval/retrieval.ts [--verbose] [--keyword-only]
//
// Reports recall@1, recall@3 and MRR overall and per probe category, so a
// change can be judged against measurement rather than a handful of anecdotes.
//
// Runs entirely against the local corpus in ./corpus.ts — no external dataset,
// no LLM calls, only embeddings. One run costs a few thousand embedding tokens.

import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Vault } from '../src/vault.js';
import { createEmbedder } from '../src/embeddings.js';
import { MEMORIES, QUERIES, type EvalQuery } from './corpus.js';

const VERBOSE = process.argv.includes('--verbose');
const KEYWORD_ONLY = process.argv.includes('--keyword-only');

interface CaseResult {
  query: EvalQuery;
  ranked: string[];
  hitAt1: boolean;
  hitAt3: boolean;
  reciprocalRank: number;
}

async function main(): Promise<void> {
  const embedder = KEYWORD_ONLY ? undefined : createEmbedder();
  if (!KEYWORD_ONLY && !embedder) {
    console.error(
      'No embedder configured. Set MODEL_PROVIDER and the matching API key, ' +
      'or pass --keyword-only to measure the lexical path alone.',
    );
    process.exit(1);
  }

  const dir = mkdtempSync(join(tmpdir(), 'engram-eval-'));
  const vault = new Vault({ owner: 'eval', dbPath: join(dir, 'v.db') }, embedder);

  // Keep a content → eval id map; Vault assigns its own ids on write.
  const idByContent = new Map<string, string>();
  try {
    for (const m of MEMORIES) {
      const stored = vault.remember({ content: m.content });
      idByContent.set(stored.id, m.id);
    }
    await vault.flush();
    if (embedder) await vault.backfillEmbeddings();

    // Embedding is fire-and-forget inside remember(), so a rate-limited or
    // failing provider leaves the vault silently unvectorised and the whole
    // benchmark measures the keyword path while claiming otherwise. Verify.
    if (embedder) {
      const embedded = countEmbedded(vault);
      if (embedded < MEMORIES.length) {
        console.error(
          `\nEmbedding incomplete: ${embedded}/${MEMORIES.length} memories have vectors. ` +
          'Usually rate limiting. Results would measure the keyword path while ' +
          'claiming otherwise — rerun with a pause between runs.',
        );
        process.exit(2);
      }
    }

    const results: CaseResult[] = [];
    for (const q of QUERIES) {
      const hits = await vault.recall({ context: q.query, limit: 5 });
      const ranked = hits.map(h => idByContent.get(h.id) ?? '?');
      const firstGold = ranked.findIndex(id => q.gold.includes(id));
      results.push({
        query: q,
        ranked,
        hitAt1: ranked.length > 0 && q.gold.includes(ranked[0]),
        hitAt3: ranked.slice(0, 3).some(id => q.gold.includes(id)),
        reciprocalRank: firstGold === -1 ? 0 : 1 / (firstGold + 1),
      });
    }

    report(results, embedder ? describeEmbedder() : 'keyword-only');
  } finally {
    await vault.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** How many memories actually have a stored vector. */
function countEmbedded(vault: Vault): number {
  const db = (vault as unknown as { store: { db: { prepare: (q: string) => { get: () => unknown } } } }).store.db;
  try {
    const row = db.prepare('SELECT count(*) AS c FROM vec_memories').get() as { c: number };
    return row.c;
  } catch {
    return 0;
  }
}

function describeEmbedder(): string {
  const provider = process.env.MODEL_PROVIDER ?? 'inferred';
  const model = process.env.ENGRAM_EMBEDDING_MODEL ?? 'provider default';
  return `${provider} / ${model}`;
}

function pct(n: number, d: number): string {
  return d === 0 ? '   n/a' : `${((100 * n) / d).toFixed(1).padStart(5)}%`;
}

function report(results: CaseResult[], config: string): void {
  const categories = [...new Set(results.map(r => r.query.probes))].sort();

  console.log('\n═══ Retrieval benchmark ═══');
  console.log(`config:   ${config}`);
  console.log(`corpus:   ${MEMORIES.length} memories, ${QUERIES.length} queries\n`);

  console.log('category        n   recall@1  recall@3     MRR');
  console.log('─────────────────────────────────────────────────');
  for (const cat of categories) {
    const rows = results.filter(r => r.query.probes === cat);
    const mrr = rows.reduce((s, r) => s + r.reciprocalRank, 0) / rows.length;
    console.log(
      `${cat.padEnd(14)} ${String(rows.length).padStart(2)}    ` +
      `${pct(rows.filter(r => r.hitAt1).length, rows.length)}    ` +
      `${pct(rows.filter(r => r.hitAt3).length, rows.length)}   ${mrr.toFixed(3)}`,
    );
  }

  const mrr = results.reduce((s, r) => s + r.reciprocalRank, 0) / results.length;
  console.log('─────────────────────────────────────────────────');
  console.log(
    `${'OVERALL'.padEnd(14)} ${String(results.length).padStart(2)}    ` +
    `${pct(results.filter(r => r.hitAt1).length, results.length)}    ` +
    `${pct(results.filter(r => r.hitAt3).length, results.length)}   ${mrr.toFixed(3)}`,
  );

  const misses = results.filter(r => !r.hitAt1);
  if (misses.length > 0) {
    console.log(`\nMissed at rank 1 (${misses.length}):`);
    for (const m of misses) {
      console.log(`  [${m.query.probes}] "${m.query.query}"`);
      console.log(`      want ${m.query.gold.join(' | ')}   got ${m.ranked.slice(0, 3).join(' > ') || '(nothing)'}`);
    }
  }

  if (VERBOSE) {
    console.log('\nAll cases:');
    for (const r of results) {
      console.log(`  ${r.hitAt1 ? '✓' : '✗'} "${r.query.query}" → ${r.ranked.slice(0, 3).join(' > ')}`);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
