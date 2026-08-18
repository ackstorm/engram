# Retrieval improvement roadmap (from the LoCoMo benchmark work)

Written 2026-08-18, after the ranking fix (`ceb1bd8`), the upstream head-to-head,
and the oracle-ceiling measurement. Numbers referenced here are documented in
CLAUDE.md ("LoCoMo benchmark") and reproducible with `bench/locomo/`.

**The frame:** the oracle ceiling says perfect retrieval with the current
answering setup caps at **85.1%**, so the honest target is 74.3 → 85.1. The gap
is not evenly distributed: **+26.3 points sit on multi-hop**, roughly +5
everywhere else. Rank work by that, not by what sounds impressive.

## Ranked by measured leverage

### 1. Multi-granularity memories — session summaries *alongside* raw turns
The sharpest lesson of the benchmark week: distilled facts alone lose the
details (upstream's extraction pipeline: 34%), raw turns alone lack connective
tissue (multi-hop recall@10 = 0.44). Nothing forces the choice. At ingest, also
write one summary memory per session as `semantic` type. Multi-hop questions
often need two facts that co-occur in a summary even when they're 40 turns
apart. Small ingestion change, fully measurable with the existing harness, and
it plays to Engram's actual thesis (consolidation) instead of against it.
**Best single bet: plausibly moves multi-hop, open-domain, and the product
story at once; an afternoon of work with the measurement rig already built.**

### 2. Query decomposition for multi-hop recall
A single embedding of "How long after X did Y happen?" points at neither X nor
Y cleanly. Detect multi-part questions, split into sub-queries with one cheap
LLM call, retrieve per sub-query, merge candidate pools before ranking.
Attacks the +26.3 directly at the retrieval layer. Measure with `run.ts` on
the multi-hop slice before believing it.

### 3. Sweep the embedding config — almost free to know
512 dims was a choice, not a measurement. Run conv0/conv1 retrieval-only at
text-embedding-3-large @ 512 / 1536 / 3072 (~$0.05 total; the harness already
parameterizes it). If 1536 buys 2-3 recall points, it's the cheapest win
available.

### 4. Make spreading activation earn its keep — or demote it
It's supposed to be the multi-hop mechanism and measurably wasn't (−0.05 hit@1
before the fix, ~0 value after). Root cause is edge quality: on dense entity
co-occurrence the implicit graph is noise. The System-2 hierarchy experiment
wired into the bench is one honest attempt; hold it to the same ablation-first
standard — if graph-discovered candidates don't move multi-hop recall@10, cut
the complexity.

### 5. Free points in the answer layer
The oracle run showed ~15 points die *after* perfect retrieval: "Be concise —
a few words" against six-item gold answers; all-or-nothing judging of
enumerations. Fixing the answer prompt (answer fully for list questions) is
legitimate and costs nothing. Relaxing the judge is NOT — keep the judge fixed
so numbers stay comparable across commits.

### 6. Engineering, when convenient
- Batch embedding calls at ingest: `embedBatch` exists but `remember()` embeds
  one at a time — ~5,900 sequential calls is why ingestion is the slow half of
  every benchmark run.
- Pin conv0+conv1 retrieval as a cheap CI-able regression gate so the next
  scoring change can't silently undo `ceb1bd8`.

## What NOT to do

- Don't chase mem0/Zep/Mnemis leaderboard numbers: they sit above our answering
  model's ceiling and their methodologies are incomparable (upstream's own 80%
  claim did not reproduce: 43.8% raw, 34.3% with its extraction pipeline).
- Don't move ingestion to extraction-only. Measured: −10 points.

## Process discipline that made this work

Ablate on conv0/1 → confirm on a holdout conversation → let the oracle bound
what a retrieval change can claim. Every scoring change gets attributed to a
pipeline layer (diag-style ablation) before the code changes.
