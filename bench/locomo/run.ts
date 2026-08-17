// LoCoMo retrieval-only benchmark: recall@k / MRR of Vault.recallScored
// against the gold evidence dia_ids. No answering LLM, no judge.
//
// Usage: npx tsx bench/locomo/run.ts [convIndex=0] [topK=10]
// Needs GEMINI_API_KEY (or OPENAI_API_KEY) for embeddings.
// The ingested vault is cached in bench/locomo/.cache/conv<i>.db — delete it
// to re-ingest (embedding config is immutable per vault).

import { existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';
import { Vault } from '../../src/vault.js';
import { createEmbedder } from '../../src/embeddings.js';

const CATEGORY_NAMES: Record<number, string> = {
  1: 'multi-hop',
  2: 'temporal',
  3: 'open-domain',
  4: 'single-hop',
  5: 'adversarial',
};

interface Turn { speaker: string; dia_id: string; text: string; blip_caption?: string }
interface QA { question: string; answer?: unknown; evidence?: string[]; category: number }

const convIndex = Number(process.argv[2] ?? 0);
const topK = Number(process.argv[3] ?? 10);

const dataset = JSON.parse(readFileSync(path.join(import.meta.dirname, 'locomo10.json'), 'utf8'));
const sample = dataset[convIndex];
if (!sample) throw new Error(`No conversation at index ${convIndex} (0-${dataset.length - 1})`);

const embedder = createEmbedder();
if (!embedder) throw new Error('No embedding provider configured — set GEMINI_API_KEY or OPENAI_API_KEY');

const cacheDir = path.join(import.meta.dirname, '.cache');
mkdirSync(cacheDir, { recursive: true });
const dbPath = path.join(cacheDir, `conv${convIndex}.db`);
const fresh = !existsSync(dbPath);
const vault = new Vault({ owner: `locomo-conv${convIndex}`, dbPath }, embedder);

if (fresh) {
  const conv = sample.conversation;
  let ingested = 0;
  for (const key of Object.keys(conv)) {
    if (!Array.isArray(conv[key])) continue;
    const date = conv[`${key}_date_time`] ?? '';
    for (const turn of conv[key] as Turn[]) {
      const caption = turn.blip_caption ? ` (shared photo: ${turn.blip_caption})` : '';
      vault.remember({
        content: `[${date}] ${turn.speaker}: ${turn.text}${caption}`,
        source: { type: 'conversation', sessionId: turn.dia_id },
      });
      // ponytail: flush every 20 to cap concurrent embed calls; batch API if too slow
      if (++ingested % 20 === 0) {
        await vault.flush();
        process.stdout.write(`\ringested ${ingested} turns`);
      }
    }
  }
  await vault.flush();
  // allSettled swallows embed failures — retry missing vectors, bounded
  for (let i = 0; i < 5; i++) {
    if ((await vault.backfillEmbeddings()) === 0) break;
  }
  console.log(`\ringested ${ingested} turns (${sample.sample_id})`);
} else {
  console.log(`reusing cached vault ${dbPath}`);
}

const qas = (sample.qa as QA[]).filter(q => q.category !== 5 && q.evidence?.length);
console.log(`${qas.length} questions with gold evidence (adversarial skipped)\n`);

interface Row { category: number; recall: number; hit1: number; hitK: number; rr: number }
const rows: Row[] = [];

for (const qa of qas) {
  const results = await vault.recallScored({ context: qa.question, limit: topK });
  const retrieved = results.map(r => r.memory.source?.sessionId).filter(Boolean) as string[];
  const gold = new Set(qa.evidence!.map(e => e.trim()));
  const found = retrieved.filter(id => gold.has(id));
  const firstRank = retrieved.findIndex(id => gold.has(id));
  rows.push({
    category: qa.category,
    recall: new Set(found).size / gold.size,
    hit1: firstRank === 0 ? 1 : 0,
    hitK: firstRank >= 0 ? 1 : 0,
    rr: firstRank >= 0 ? 1 / (firstRank + 1) : 0,
  });
  process.stdout.write(`\rqueried ${rows.length}/${qas.length}`);
}
console.log('\n');

function report(label: string, subset: Row[]) {
  const avg = (f: (r: Row) => number) => (subset.reduce((s, r) => s + f(r), 0) / subset.length).toFixed(3);
  console.log(
    `${label.padEnd(18)} n=${String(subset.length).padEnd(4)} ` +
    `recall@${topK}=${avg(r => r.recall)}  hit@1=${avg(r => r.hit1)}  ` +
    `hit@${topK}=${avg(r => r.hitK)}  MRR=${avg(r => r.rr)}`
  );
}

report('ALL', rows);
for (const cat of [...new Set(rows.map(r => r.category))].sort()) {
  report(`  ${CATEGORY_NAMES[cat] ?? `category ${cat}`}`, rows.filter(r => r.category === cat));
}

await vault.close();
