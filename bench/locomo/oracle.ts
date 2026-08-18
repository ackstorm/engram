// LoCoMo oracle-context ceiling: answer each question from the GOLD evidence
// turns only, judged the same way as e2e.ts. No vault, no retriever, no
// embeddings. This is the score a perfect retriever would get, and therefore
// the upper bound on everything bench/locomo/run.ts can ever buy.
//
// Usage: npx tsx bench/locomo/oracle.ts [conv|all=all]
// Env: LITELLM_API_KEY

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

const CATEGORY_NAMES: Record<number, string> = {
  1: 'multi-hop', 2: 'temporal', 3: 'open-domain', 4: 'single-hop',
};

const CHAT_URL = 'https://api.ackstorm.ai/v1/chat/completions';
const CHAT_MODEL = process.env.ENGRAM_BENCH_LLM ?? 'gemini-flash-latest';
const CHAT_KEY = process.env.LITELLM_API_KEY;
if (!CHAT_KEY) throw new Error('LITELLM_API_KEY not set');

const arg = process.argv[2] ?? 'all';
const dataset = JSON.parse(readFileSync(path.join(import.meta.dirname, 'locomo10.json'), 'utf8'));
const convs: number[] = arg === 'all' ? dataset.map((_: unknown, i: number) => i) : [Number(arg)];

const resultsDir = path.join(import.meta.dirname, '.results');
mkdirSync(resultsDir, { recursive: true });
const resultPath = path.join(resultsDir, `oracle-${CHAT_MODEL}.json`);

async function chat(system: string, user: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CHAT_KEY}` },
        body: JSON.stringify({
          model: CHAT_MODEL,
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

/** dia_id -> the same snippet string e2e.ts stores as a memory, so the two
 *  runs differ ONLY in which snippets the answerer sees. */
function snippetsById(conv: Record<string, unknown>): Map<string, string> {
  const out = new Map<string, string>();
  for (const key of Object.keys(conv)) {
    if (!Array.isArray(conv[key])) continue;
    const date = (conv[`${key}_date_time`] as string) ?? '';
    for (const turn of conv[key] as Turn[]) {
      const caption = turn.blip_caption ? ` (shared photo: ${turn.blip_caption})` : '';
      out.set(turn.dia_id, `[${date}] ${turn.speaker}: ${turn.text}${caption}`);
    }
  }
  return out;
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

if (existsSync(resultPath)) {
  console.log(`cached ${resultPath} — delete it to re-run`);
}

const all: Rec[] = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : [];

if (all.length === 0) {
  for (const convIndex of convs) {
    const sample = dataset[convIndex];
    const byId = snippetsById(sample.conversation);
    const speakers = `${sample.conversation.speaker_a} and ${sample.conversation.speaker_b}`;
    const qas = sample.qa.filter((q: { category: number; evidence?: string[] }) =>
      q.category !== 5 && q.evidence?.length);
    let done = 0;

    const records = await pool(qas, 4, async (qa: any): Promise<Rec> => {
      const memories = (qa.evidence as string[])
        .map(id => byId.get(id.trim()))
        .filter(Boolean)
        .map((s, i) => `${i + 1}. ${s}`)
        .join('\n');
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

    all.push(...records);
    console.log(`\nconv${convIndex}: ${records.filter(r => r.correct).length}/${records.length}`);
  }
  writeFileSync(resultPath, JSON.stringify(all, null, 1));
}

console.log(`\n=== Oracle ceiling (${CHAT_MODEL}, gold evidence only) ===`);
const pct = (rs: Rec[]) => `${((rs.filter(r => r.correct).length / rs.length) * 100).toFixed(1)}%  (n=${rs.length})`;
console.log(`ALL          ${pct(all)}`);
for (const cat of [1, 2, 3, 4]) {
  const rs = all.filter(r => r.category === cat);
  if (rs.length) console.log(`${CATEGORY_NAMES[cat].padEnd(12)} ${pct(rs)}`);
}
