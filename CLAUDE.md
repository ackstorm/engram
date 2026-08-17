# CLAUDE.md

Engram — universal memory layer for AI agents (SQLite + sqlite-vec).

## References

Detailed design/constraint docs live in `./docs/references`, indexed here:

- [Embedding config is immutable per vault](docs/references/embedding-config-is-immutable.md) — permanent architectural constraint of the SQLite/sqlite-vec design.
- [Memory scope and types — design](docs/references/memory-scope-and-types.md) — the project/global vault split, the `profile` memory type, and the repair path for mis-targeted writes. Implemented across Plans 1-3; see `docs/superpowers/plans/`.

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
