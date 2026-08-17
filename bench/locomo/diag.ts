// Ablation diagnostic for the LoCoMo hit@1 gap: score the same questions
// under different retrieval configs to find which layer hurts ranking.
// Usage: npx tsx bench/locomo/diag.ts [convIndex=0] [topK=10]
// Requires a cached vault from run.ts (bench/locomo/.cache/conv<i>.db).

import { copyFileSync, readFileSync, rmSync } from 'fs';
import path from 'path';
import { Vault, fuseRetrievalScores, normaliseBm25 } from '../../src/vault.js';
import { createEmbedder, type EmbeddingProvider } from '../../src/embeddings.js';
import { tokenizeQuery } from '../../src/store.js';

const convIndex = Number(process.argv[2] ?? 0);
const topK = Number(process.argv[3] ?? 10);

const dataset = JSON.parse(readFileSync(path.join(import.meta.dirname, 'locomo10.json'), 'utf8'));
const sample = dataset[convIndex];
const dbPath = path.join(import.meta.dirname, '.cache', `conv${convIndex}.db`);

const inner = createEmbedder();
if (!inner) throw new Error('No embedding key configured');
const cache = new Map<string, number[]>();
const embedder: EmbeddingProvider = {
  embed: async (t: string) => {
    if (!cache.has(t)) cache.set(t, await inner.embed(t));
    return cache.get(t)!;
  },
  embedBatch: (ts: string[]) => Promise.all(ts.map(t => embedder.embed(t))),
  dimensions: () => inner.dimensions(),
};

interface QA { question: string; evidence?: string[]; category: number }
const qas = (sample.qa as QA[]).filter(q => q.category !== 5 && q.evidence?.length);

function score(ranked: string[][], name: string) {
  let hit1 = 0, rr = 0, recall = 0;
  ranked.forEach((ids, i) => {
    const gold = new Set(qas[i].evidence!.map(e => e.trim()));
    const first = ids.findIndex(id => gold.has(id));
    if (first === 0) hit1++;
    if (first >= 0) rr += 1 / (first + 1);
    recall += new Set(ids.filter(id => gold.has(id))).size / gold.size;
  });
  const n = ranked.length;
  console.log(`${name.padEnd(28)} hit@1=${(hit1 / n).toFixed(3)}  MRR=${(rr / n).toFixed(3)}  recall@${topK}=${(recall / n).toFixed(3)}`);
}

async function withVault(fn: (v: Vault) => Promise<string[][]>): Promise<string[][]> {
  const work = `${dbPath}.diag`;
  copyFileSync(dbPath, work);
  const v = new Vault({ owner: `locomo-conv${convIndex}` , dbPath: work }, embedder);
  const out = await fn(v);
  await v.close();
  rmSync(work, { force: true });
  return out;
}

const diaOf = (v: Vault) => {
  const store = (v as any).store;
  const byId = new Map<string, string>();
  for (const m of store.exportAll().memories) byId.set(m.id, m.source?.sessionId ?? '');
  return byId;
};

// A: full recallScored
score(await withVault(async v => {
  const out: string[][] = [];
  for (const qa of qas) {
    const r = await v.recallScored({ context: qa.question, limit: topK });
    out.push(r.map(x => x.memory.source?.sessionId ?? ''));
  }
  return out;
}), 'A full recallScored');

// B: recallScored, spread off
score(await withVault(async v => {
  const out: string[][] = [];
  for (const qa of qas) {
    const r = await v.recallScored({ context: qa.question, limit: topK, spread: false });
    out.push(r.map(x => x.memory.source?.sessionId ?? ''));
  }
  return out;
}), 'B spread:false');

// C/D/E: store-level, no boosts/spread/step-8
score(await withVault(async v => {
  const store = (v as any).store;
  const dia = diaOf(v);
  const out: string[][] = [];
  for (const qa of qas) {
    const emb = await embedder.embed(qa.question);
    const vec = new Map<string, number>(
      store.searchByVector(emb, 50).map((h: any) => [h.memoryId, h.similarity]));
    const bm = store.searchBM25(qa.question, 50);
    const fused = fuseRetrievalScores(vec, normaliseBm25(bm, tokenizeQuery(qa.question).length), vec.size > 0, bm.length > 0);
    const ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK);
    out.push(ranked.map(([id]) => dia.get(id) ?? ''));
  }
  return out;
}), 'C fused vector+BM25 only');

score(await withVault(async v => {
  const store = (v as any).store;
  const dia = diaOf(v);
  const out: string[][] = [];
  for (const qa of qas) {
    const emb = await embedder.embed(qa.question);
    const hits = store.searchByVector(emb, topK);
    out.push(hits.map((h: any) => dia.get(h.memoryId) ?? ''));
  }
  return out;
}), 'D vector only');

score(await withVault(async v => {
  const store = (v as any).store;
  const dia = diaOf(v);
  const out: string[][] = [];
  for (const qa of qas) {
    const hits = store.searchBM25(qa.question, topK);
    out.push(hits.map((h: any) => dia.get(h.memoryId) ?? ''));
  }
  return out;
}), 'E BM25 only');
