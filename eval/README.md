# Retrieval evaluation

A labelled benchmark for recall quality, so scoring changes are measured rather
than argued from anecdotes. Two rounds of tuning went wrong before this existed,
both times by generalising from a four-memory vault.

```bash
OPENAI_API_KEY=$KEY OPENAI_BASE_URL=https://your-gateway \
ENGRAM_EMBEDDING_MODEL=text-embedding-3-small \
  npm run eval:retrieval          # add --verbose for every case, --keyword-only for the lexical path
```

Costs a few thousand embedding tokens per run and makes no LLM calls.

## What it measures

49 memories, 25 labelled queries, reported as recall@1, recall@3 and MRR, split
by what each query probes:

| Category | Tests |
|---|---|
| `semantic` | gold shares little or no vocabulary with the query |
| `lexical` | the distinctive term appears verbatim |
| `lexical-trap` | a distractor shares a distinctive word but not the meaning |
| `paraphrase` | same meaning, different words |
| `multi` | more than one memory is a legitimate answer |

The traps matter. Both regressions this suite was built after involved a
distractor winning on a shared word — a database note containing "incident"
beating the on-call rotation for *who handles incidents*.

**It verifies its own validity.** Embedding is fire-and-forget inside
`remember()`, so a rate-limited provider silently leaves the vault unvectorised
and the benchmark would measure the keyword path while reporting an embedding
config. The harness counts stored vectors and exits non-zero if any are missing.
If you sweep several configurations back to back, pause between runs.

## Measured results

Recorded 2026-08-16, corpus as committed, `ENGRAM_HYBRID_ALPHA` at its 0.9
default.

### Hybrid alpha (vector share of the blend)

| alpha | recall@1 | recall@3 | MRR |
|---|---|---|---|
| 0.50 | 56.0% | 80.0% | 0.675 |
| 0.75 | 64.0% | 88.0% | 0.771 |
| **0.90** | **68.0%** | **92.0%** | **0.810** |
| 0.95 | 68.0% | 96.0% | 0.821 |
| 1.00 | 68.0% | 96.0% | 0.823 |

0.90 rather than 0.95: the gap is one query out of 25, inside the noise, and
this corpus under-states lexical search — every lexical case in it is a
distinctive single word the embedder also resolves. Real vaults carry
identifiers, error codes and jargon where BM25 earns more.

### Retriever contribution

| Path | recall@1 | semantic recall@1 |
|---|---|---|
| keyword only | 36.0% | 12.5% |
| hybrid | 68.0% | 50.0% |

The two retrievers do genuinely different work. This is why
`MemoryRouter.open()` refuses to start without an embedder unless
`ENGRAM_ALLOW_NO_EMBEDDER=1` is set.

### Embedding model

All via an OpenAI-compatible gateway.

| Model | dims | recall@1 | recall@3 | MRR | storage |
|---|---|---|---|---|---|
| text-embedding-3-small | 1536 | 68.0% | 92.0% | 0.810 | 1× |
| text-embedding-3-small | 512 (MRL) | 68.0% | 92.0% | 0.810 | 0.33× |
| text-embedding-3-large | 3072 | 68.0% | 100.0% | 0.840 | 2× |
| **text-embedding-3-large** | **512 (MRL)** | **72.0%** | **100.0%** | **0.853** | **0.33×** |

`text-embedding-3-large` truncated to 512 dimensions is best on every measured
axis and uses the least storage. Model quality dominates dimension count, which
matches the Mnemis ablation (ACL 2026, Table 6), where Qwen3-Embedding at 128
dimensions beat BGE-M3 at 1024.

Two caveats before adopting it:

- **Truncation requires gateway support.** Setting `ENGRAM_EMBEDDING_DIMS` makes
  Engram send OpenAI's `dimensions` parameter, which some OpenAI-compatible
  gateways reject. The shipped defaults stay at `text-embedding-3-small` at its
  native width so they work everywhere.
- **The choice is permanent per vault.** The dimension is fixed on first write
  and there is no migration path. See
  `docs/references/embedding-config-is-immutable.md`.

### Things measured and rejected

Recorded so they are not rebuilt on intuition.

| Change | Measured | Verdict |
|---|---|---|
| Extraction reflection pass | +4.3% entities over three transcript-like texts, against a 15% bar set before measuring | Rejected. The one entity gained was "Tuesday" — a date. Does not pay for a second LLM call per extraction. |
| Removing the salience/stability weighting | MRR 0.821 against 0.810 | Not acted on. This corpus has uniform auto-extracted salience, so it can show what the stage costs but never what it contributes. Needs a corpus with deliberately varied salience. |
| Relative semantic gate at 40% of top cosine | Caught exactly one case, measured at 39.4% | Rejected. The threshold was fitted to a single observation. The BM25 noise floor fixes that case on evidence instead. |
| Neural reranking stage | Mnemis ablation: 89.1 with, 89.1 without | Not built. |

## Interpreting a run

`recall@3` well above `recall@1` means the ranking is close but the tie-break is
wrong — usually a secondary signal (entity, topic, recency) outweighing the
primary retriever. `recall@3` itself being low means the retriever never found
the memory, which is an embedding or indexing problem rather than a scoring one.

The `Missed at rank 1` list prints what won instead, which is normally enough to
tell those two apart without instrumenting anything.

## Extending the corpus

Add to `MEMORIES` and `QUERIES` in `corpus.ts`. Keep the distractors: a corpus
where every memory is obviously distinct measures nothing, because any retriever
passes it. Some labels are genuinely arguable — "who handles incidents?" could
reasonably return the blameless-incident-review process note — and a few cases
are deliberately left that way so the score never reaches 100% by construction.
