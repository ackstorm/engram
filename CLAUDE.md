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
