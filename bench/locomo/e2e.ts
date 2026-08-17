// LoCoMo end-to-end benchmark: retrieve top-k memories, answer with an LLM,
// judge against the gold answer with an LLM. This is the metric published
// e2e LoCoMo scores use (mem0/upstream ~80%); adversarial (cat 5) excluded,
// 1540 questions total — same protocol as mem0's eval.
//
// Usage: npx tsx bench/locomo/e2e.ts [conv|all=all] [topK=10]
// Env: LITELLM_API_KEY (chat via api.ackstorm.ai) + the embedding env from
// CLAUDE.md. Per-conv results cached in .results/e2e-conv<i>.json — delete to
// re-run a conversation. Ingestion shares .cache/ with run.ts.

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { Vault } from '../../src/vault.js';
import { createEmbedder } from '../../src/embeddings.js';

const CATEGORY_NAMES: Record<number, string> = {
  1: 'multi-hop', 2: 'temporal', 3: 'open-domain', 4: 'single-hop',
};

const CHAT_URL = 'https://api.ackstorm.ai/v1/chat/completions';
const CHAT_MODEL = process.env.ENGRAM_BENCH_LLM ?? 'gemini-flash-latest';
const CHAT_KEY = process.env.LITELLM_API_KEY;
if (!CHAT_KEY) throw new Error('LITELLM_API_KEY not set');

const arg = process.argv[2] ?? 'all';
const topK = Number(process.argv[3] ?? 10);
const dataset = JSON.parse(readFileSync(path.join(import.meta.dirname, 'locomo10.json'), 'utf8'));
const convs: number[] = arg === 'all' ? dataset.map((_: unknown, i: number) => i) : [Number(arg)];

const embedder = createEmbedder();
if (!embedder) throw new Error('No embedding provider configured');

const cacheDir = path.join(import.meta.dirname, '.cache');
const resultsDir = path.join(import.meta.dirname, '.results');
mkdirSync(cacheDir, { recursive: true });
mkdirSync(resultsDir, { recursive: true });

async function chat(system: string, user: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CHAT_KEY}` },
      body: JSON.stringify({
        model: CHAT_MODEL,
        temperature: 0,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    });
    if (res.ok) {
      const body = await res.json();
      return body.choices?.[0]?.message?.content?.trim() ?? '';
    }
    if (attempt >= 4) throw new Error(`chat ${res.status}: ${(await res.text()).slice(0, 200)}`);
    await new Promise(r => setTimeout(r, attempt * 15_000));
  }
}

interface Turn { speaker: string; dia_id: string; text: string; blip_caption?: string }

async function ensureIngested(convIndex: number): Promise<string> {
  const dbPath = path.join(cacheDir, `conv${convIndex}.db`);
  if (existsSync(dbPath)) return dbPath;
  const sample = dataset[convIndex];
  const vault = new Vault({ owner: `locomo-conv${convIndex}`, dbPath }, embedder);
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
      if (++ingested % 20 === 0) await vault.flush();
    }
  }
  await vault.flush();
  for (let i = 0; i < 5; i++) {
    if ((await vault.backfillEmbeddings()) === 0) break;
  }
  await vault.close();
  console.log(`conv${convIndex}: ingested ${ingested} turns`);
  return dbPath;
}

async function pool<T, R>(items: T[], size: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

interface Rec { category: number; question: string; gold: string; answer: string; correct: boolean }

for (const convIndex of convs) {
  const resultPath = path.join(resultsDir, `e2e-conv${convIndex}.json`);
  if (existsSync(resultPath)) { console.log(`conv${convIndex}: cached result, skipping`); continue; }

  const sample = dataset[convIndex];
  const dbPath = await ensureIngested(convIndex);
  const workPath = `${dbPath}.work`;
  copyFileSync(dbPath, workPath);
  const vault = new Vault({ owner: `locomo-conv${convIndex}`, dbPath: workPath }, embedder);

  const speakers = `${sample.conversation.speaker_a} and ${sample.conversation.speaker_b}`;
  const qas = sample.qa.filter((q: { category: number }) => q.category !== 5);
  let done = 0;

  const records = await pool(qas, 4, async (qa: any): Promise<Rec> => {
    const hits = await vault.recallScored({ context: qa.question, limit: topK });
    const memories = hits.map((h, i) => `${i + 1}. ${h.memory.content}`).join('\n');
    const answer = await chat(
      `You answer questions about a long conversation between ${speakers}, using only the retrieved memory snippets provided. Each snippet is one dialogue turn prefixed with its session timestamp. Be concise — a few words. For date/time questions give the specific date. If the memories are insufficient, give your best guess from them.`,
      `Memories:\n${memories}\n\nQuestion: ${qa.question}\nAnswer:`,
    );
    const gold = String(qa.answer ?? '');
    const verdict = await chat(
      'You grade answers to questions about a conversation. Reply with exactly one word: CORRECT if the candidate answer conveys the same information as the gold answer (paraphrase, date-format differences, and extra correct detail are all fine), or WRONG otherwise.',
      `Question: ${qa.question}\nGold answer: ${gold}\nCandidate answer: ${answer}`,
    );
    process.stdout.write(`\rconv${convIndex}: ${++done}/${qas.length}`);
    return { category: qa.category, question: qa.question, gold, answer, correct: /^correct/i.test(verdict) };
  });

  await vault.close();
  rmSync(workPath, { force: true });
  writeFileSync(resultPath, JSON.stringify(records, null, 1));
  const acc = records.filter(r => r.correct).length / records.length;
  console.log(`\nconv${convIndex}: accuracy ${(acc * 100).toFixed(1)}% (n=${records.length})`);
}

// ── Aggregate over every conversation that has results ──
const all: Rec[] = [];
for (const i of dataset.keys()) {
  const p = path.join(resultsDir, `e2e-conv${i}.json`);
  if (existsSync(p)) all.push(...JSON.parse(readFileSync(p, 'utf8')));
}
if (all.length > 0) {
  console.log(`\n=== E2E accuracy (${CHAT_MODEL}, top-${topK}) ===`);
  const pct = (rs: Rec[]) => `${((rs.filter(r => r.correct).length / rs.length) * 100).toFixed(1)}%  (n=${rs.length})`;
  console.log(`ALL          ${pct(all)}`);
  for (const cat of [1, 2, 3, 4]) {
    const rs = all.filter(r => r.category === cat);
    if (rs.length) console.log(`${CATEGORY_NAMES[cat].padEnd(12)} ${pct(rs)}`);
  }
}
