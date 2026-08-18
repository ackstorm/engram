# CLAUDE.md

Engram — universal memory layer for AI agents (SQLite + sqlite-vec).

## References

Detailed design/constraint docs live in `./docs/references`, indexed here:

- [Embedding config is immutable per vault](docs/references/embedding-config-is-immutable.md) — permanent architectural constraint of the SQLite/sqlite-vec design.
- [Memory scope and types — design](docs/references/memory-scope-and-types.md) — the project/global vault split, the `profile` memory type, and the repair path for mis-targeted writes. Implemented across Plans 1-3; see `docs/superpowers/plans/`.
- [Retrieval improvement roadmap](docs/references/retrieval-improvement-roadmap.md) — ranked next steps from the LoCoMo work: multi-granularity memories, query decomposition, embedding sweep; what not to do and why.

## LoCoMo benchmark

`bench/locomo/` scores retrieval (`Vault.recallScored`) against LoCoMo's gold
evidence dia_ids — recall@k / hit@1 / MRR, no answering LLM, no judge:

```bash
OPENAI_API_KEY=$LITELLM_API_KEY OPENAI_BASE_URL=https://api.ackstorm.ai \
MODEL_PROVIDER=openai ENGRAM_EMBEDDING_MODEL=openai.text-embedding-3-large \
ENGRAM_EMBEDDING_DIMS=512 npx tsx bench/locomo/run.ts <conv 0-9> <topK=10>
```

- Ingested vaults are cached in `bench/locomo/.cache/` (delete to re-ingest —
  embedding config is immutable per vault). Queries run on a throwaway copy of
  the cache so access-count/stability updates never pollute later runs.
- Before touching scoring code, attribute any ranking change to a pipeline
  layer with an ablation pass (raw fusion, vector-only, BM25-only, no-boosts).
  `bench/locomo/diag.ts` does this; it is deliberately untracked (local
  scratchpad, gitignored) — rebuild it from the layers in `recallScored` if
  missing.
- Baseline 2026-08-17, text-embedding-3-large @ 512 dims, after sizing
  secondary boosts to primary-score gaps: conv0 hit@1=0.327 MRR=0.481
  recall@10=0.762; conv1 (holdout) hit@1=0.506 MRR=0.607 recall@10=0.770.
- These retrieval-only numbers are NOT comparable to published end-to-end
  LoCoMo accuracies (e.g. upstream's ~80%): those measure an LLM answering
  from retrieved context, judged by another LLM — a laxer target than exact
  evidence-turn ranking.
- `bench/locomo/e2e.ts` (same env, plus `LITELLM_API_KEY`) runs that
  end-to-end protocol: answer from top-k with `gemini-flash-latest`
  (`ENGRAM_BENCH_LLM` overrides), LLM-judged, all 1,540 non-adversarial
  questions — mem0's question count, so roughly comparable to published
  numbers. Per-conv results cached in `bench/locomo/.results/` (delete to
  re-run). E2E baseline 2026-08-17, same embedder + ranking fix: **74.3%**
  (multi-hop 44.3, temporal 80.7, open-domain 65.6, single-hop 82.9).
- Head-to-head vs upstream tstockham96/engram (same harness ported to its
  `recall()`, identical embeddings/prompts/judge, 2026-08-17): upstream
  scores **43.8%** e2e (multi-hop 15.6, temporal 53.9, open-domain 41.7,
  single-hop 49.7) and recall@10 0.41-0.49 vs the fork's 0.76-0.77 on
  conv0/1. Upstream's README ~80% claim did not reproduce under this
  protocol. The fork improves every category and every conversation.
- **Oracle ceiling 2026-08-18** (`bench/locomo/oracle.ts`, answers built from the
  gold evidence turns only, gemini-flash-latest, answer+judge prompts copied
  verbatim from `e2e.ts`): **85.1%** overall (multi-hop 70.6, temporal 86.6,
  open-domain 69.6, single-hop 91.1; n=1536 — 4 open-domain questions carry no
  evidence label). This bounds every retrieval change: the retrieval-attributable
  gap is oracle minus e2e, so **+10.8 overall and +26.3 on multi-hop**, not 100
  minus e2e.
  Two consequences. First, 29.4 points of multi-hop failure survive perfect
  retrieval — more than retrieval itself is worth — split across an all-or-nothing
  judge on enumerations ("Transgender" graded WRONG against "Transgender woman";
  5 of 6 listed activities graded WRONG), LoCoMo evidence labels that do not
  contain the gold answer ("What did Melanie paint recently?" → gold "sunset",
  oracle "Not mentioned"), and an answer prompt that says "Be concise — a few
  words" to questions whose gold answer is a six-item list. Second, Mnemis's
  published 93.9 is above our answering model's ceiling, so it is not a reachable
  target here at any retrieval quality; the honest target is 74.3 -> 85.1.
- **Context-budget ablation 2026-08-18**: at top-30 the same pipeline scores
  **81.0%** e2e (multi-hop 60.3, temporal 84.4, open-domain 61.5, single-hop
  88.8) against 74.3% at top-10. No ranking or architecture change — purely how
  many snippets the answerer sees. That is 6.7 of the 10.8 points available
  below the oracle ceiling, and 16.0 of multi-hop's 26.3. Open-domain is the one
  category that got *worse* (65.6 -> 61.5): 20 extra snippets of loosely related
  context appear to dilute an inference-style question rather than support it.
- **Graph-route ablation 2026-08-18** (`graphLimit`, `bench/locomo/run.ts <conv>
  <topK> <graphLimit>`, conv0): at an equal 30-snippet budget, 10+20 scores
  recall 0.761 / multi-hop 0.534 against 30+0's 0.890 / 0.740 — and against the
  10+0 baseline's 0.762 / 0.542. **The 20 reserved slots recover nothing.**
  Spreading activation discovers essentially no evidence the primary ranking
  missed, so the slots are better spent on more of the ranked list.
  Mnemis's +15.3 for its graph route (System-1 RAG 73.8 -> RAG+Graph 89.1) does
  not reproduce here, and the substrate explains why: their base graph is
  Graphiti-extracted typed relations, while the benchmark vaults ingest with
  rule-based extraction and no LLM, so the edge set is far too sparse to
  traverse. `graphLimit` stays 0 by default. Re-test only against a corpus
  ingested with LLM extraction.
