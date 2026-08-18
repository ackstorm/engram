// LoCoMo end-to-end benchmark: retrieve top-k memories, answer with an LLM,
// judge against the gold answer with an LLM. This is the metric published
// e2e LoCoMo scores use (mem0/upstream ~80%); adversarial (cat 5) excluded,
// 1540 questions total — same protocol as mem0's eval.
//
// Usage: npx tsx bench/locomo/e2e.ts [conv|all=all] [topK=10] [graphLimit=0]
// Env: ENGRAM_BENCH_PROMPT=v1|v2 selects the answerer prompt (default v1).
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
// The judge is pinned separately from the answerer. Swapping the answering
// model must not silently swap the grader too — a stricter or laxer judge
// would move the score for a reason that has nothing to do with the system
// under test, and every number recorded so far was graded by this default.
const JUDGE_MODEL = process.env.ENGRAM_BENCH_JUDGE ?? 'gemini-flash-latest';
const CHAT_KEY = process.env.LITELLM_API_KEY;
if (!CHAT_KEY) throw new Error('LITELLM_API_KEY not set');

const arg = process.argv[2] ?? 'all';
const topK = Number(process.argv[3] ?? 10);
// Reserved slice for graph-discovered memories (Vault.recallScored graphLimit).
// 0 reproduces the pre-Phase-3 baseline exactly.
const graphLimit = Number(process.argv[4] ?? 0);
// Mnemis System-2. Costs an LLM call per layer per query, plus a build measured
// in minutes, so it is opt-in even inside the benchmark.
const useHierarchy = process.env.ENGRAM_BENCH_HIERARCHY === '1';
// The cache key has to carry every knob that changes the answer, or a second
// configuration silently reports the first one's numbers.
// Answer-prompt variant. The oracle run showed points dying AFTER perfect
// retrieval, partly because v1 says "a few words" to questions whose gold
// answer is a six-item list. v1 stays the default so every previously recorded
// number remains reproducible; the tag keeps their caches apart.
const promptVariant = process.env.ENGRAM_BENCH_PROMPT ?? 'v1';
const runTag = `${CHAT_MODEL}-k${topK}g${graphLimit}${useHierarchy ? '-h' : ''}${promptVariant === 'v1' ? '' : `-${promptVariant}`}`;

// The JUDGE prompt is deliberately NOT variant-controlled. Relaxing the grader
// would make numbers incomparable across commits; only the answerer may change.
const ANSWER_SYSTEM: Record<string, (speakers: string) => string> = {
  v1: speakers =>
    `You answer questions about a long conversation between ${speakers}, using only the retrieved memory snippets provided. Each snippet is one dialogue turn prefixed with its session timestamp. Be concise — a few words. For date/time questions give the specific date. If the memories are insufficient, give your best guess from them.`,
  v2: speakers =>
    `You answer questions about a long conversation between ${speakers}, using only the retrieved memory snippets provided. Each snippet is one dialogue turn prefixed with its session timestamp.

Be concise: a few words for a single fact, and no explanation or preamble.

When the question asks what someone did, likes, owns, read, made, or took part in, the answer is usually a SET rather than one item. List every distinct item the memories support, separated by commas. Do not stop at the clearest one.

For date/time questions give the specific date. If the memories are insufficient, give your best guess from them.`,
};
if (!(promptVariant in ANSWER_SYSTEM)) {
  throw new Error(`Unknown ENGRAM_BENCH_PROMPT='${promptVariant}' (have: ${Object.keys(ANSWER_SYSTEM).join(', ')})`);
}
const dataset = JSON.parse(readFileSync(path.join(import.meta.dirname, 'locomo10.json'), 'utf8'));
const convs: number[] = arg === 'all' ? dataset.map((_: unknown, i: number) => i) : [Number(arg)];

const embedder = createEmbedder();
if (!embedder) throw new Error('No embedding provider configured');

const cacheDir = path.join(import.meta.dirname, '.cache');
const resultsDir = path.join(import.meta.dirname, '.results');
mkdirSync(cacheDir, { recursive: true });
mkdirSync(resultsDir, { recursive: true });

async function chat(system: string, user: string, model: string = CHAT_MODEL): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CHAT_KEY}` },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (res.ok) {
        const body = await res.json();
        return body.choices?.[0]?.message?.content?.trim() ?? '';
      }
      if (attempt >= 4) throw new Error(`chat ${res.status}: ${(await res.text()).slice(0, 200)}`);
    } catch (err) {
      // hung/refused connections must retry too, not crash the run
      if (attempt >= 4) throw err;
    }
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
  const resultPath = path.join(resultsDir, `e2e-conv${convIndex}-${runTag}.json`);
  if (existsSync(resultPath)) { console.log(`conv${convIndex}: cached result, skipping`); continue; }

  const sample = dataset[convIndex];
  const dbPath = await ensureIngested(convIndex);
  const workPath = `${dbPath}.work`;
  copyFileSync(dbPath, workPath);
  const vault = new Vault({
    owner: `locomo-conv${convIndex}`,
    dbPath: workPath,
    llm: useHierarchy ? {
      apiKey: process.env.LITELLM_API_KEY!,
      model: process.env.ENGRAM_BENCH_LLM ?? 'gemini-flash-latest',
      baseUrl: 'https://api.ackstorm.ai',
    } : undefined,
  }, embedder);

  if (useHierarchy) {
    const started = Date.now();
    const built = await vault.buildHierarchy();
    console.log(`hierarchy: ${built.categories} categories, ${built.layers} layers, ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }

  const speakers = `${sample.conversation.speaker_a} and ${sample.conversation.speaker_b}`;
  const qas = sample.qa.filter((q: { category: number }) => q.category !== 5);
  let done = 0;

  const records = await pool(qas, 4, async (qa: any): Promise<Rec> => {
    const hits = await vault.recallScored({ context: qa.question, limit: topK, graphLimit, hierarchy: useHierarchy });
    const memories = hits.map((h, i) => `${i + 1}. ${h.memory.content}`).join('\n');
    const answer = await chat(
      ANSWER_SYSTEM[promptVariant](speakers),
      `Memories:\n${memories}\n\nQuestion: ${qa.question}\nAnswer:`,
    );
    const gold = String(qa.answer ?? '');
    const verdict = await chat(
      // JUDGE_MODEL, not the answerer — see the constant above.
      'You grade answers to questions about a conversation. Reply with exactly one word: CORRECT if the candidate answer conveys the same information as the gold answer (paraphrase, date-format differences, and extra correct detail are all fine), or WRONG otherwise.',
      `Question: ${qa.question}\nGold answer: ${gold}\nCandidate answer: ${answer}`,
      JUDGE_MODEL,
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
  const p = path.join(resultsDir, `e2e-conv${i}-${runTag}.json`);
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
