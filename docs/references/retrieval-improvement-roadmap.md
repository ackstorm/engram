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

## Path to 95% — reviewed 2026-08-18

Requested target: 95% e2e. This section decomposes the remaining gap from
measurements, ranks what can close it, and states plainly which part cannot be
closed by retrieval work.

### Where we actually are

| configuration | e2e |
|---|---|
| session start (k=10, answer prompt v1) | 74.3% |
| + context budget k=30 | 81.0% |
| + answer prompt v2 | **82.3%** |

The two product fixes landed today — interjection filtering in `src/extract.ts`
and IDF-weighted entity boosts in `recallScored` — are NOT in that 82.3%: every
e2e run so far used vaults carrying the entity noise. Their measured effect is
on ranking (conv0 hit@1 0.327 -> 0.387; conv1 holdout 0.444 -> 0.519) and
ranking moves e2e weakly once the answerer sees 30 snippets. An everything-on
run is still owed.

### What the remaining 17.7% is made of

Classified over the 273 failures of the v2 run by overlap between the answer
and the gold items:

| bucket | failures | score cost | what it is |
|---|---|---|---|
| all gold items already in the answer | 22 | 1.4 pts | graded wrong anyway — over-listing. v2 told the model to list everything and the judge penalises supersets |
| partial gold overlap | 74 | 4.8 pts | genuinely incomplete: some items found, others missing |
| little or no overlap | 177 | 11.5 pts | wrong answer: evidence missed, misread, or gold label is unreachable |

The middle and bottom rows are where 95% lives, and only the middle row is
clearly ours.

### The honest constraint

**95% is above published state of the art.** Mnemis reports 93.9 on this
benchmark with GPT-4.1-mini as the answerer. Our answerer is
`gemini-flash-latest`, and the oracle run — answering from gold evidence, i.e.
retrieval doing nothing wrong — scored **85.1%** under prompt v1. Prompt work
lifts that some (conv0 reached 84.9% against its own 82.0% oracle), but the gap
between ~88% and 95% is not a retrieval gap. It is the answering model, plus a
judge that grades enumerations all-or-nothing and a dataset whose evidence
labels sometimes omit their own gold answer.

Concretely: **a credible target for retrieval work alone is 87-89%.** Reaching
95% requires changing the answerer, and should be attempted only after the
measurement below says how much that is worth.

### Ranked by measured leverage, cheapest-to-inform first

**1. Measure the answering model's contribution. Do this before anything else.**
`ENGRAM_BENCH_LLM` already selects the answerer. Run conv0+conv1 e2e at k=30
with a stronger model (~460 questions, not the full 1,540). If a stronger
answerer alone moves those two conversations 5+ points, then the ceiling
conversation is settled and every later retrieval change gets measured against
a realistic bar. If it moves 1 point, retrieval is the whole game and 95% is
out of reach at any retrieval quality. Either answer reshapes this list.
Cost: ~900 chat calls. This is the single highest-information run available.

**2. Answer format v3 — stop over-listing.** v2 traded under-listing for
over-listing: 22 failures now contain every gold item and are still graded
wrong. The instruction wants to be "list the items that directly answer the
question; do not pad with related items", plus a hard "no preamble" (several
failures still open with "Based on the memories, ..."). Free, one run to verify,
and note v2 itself only reached p=0.052 over v1 — treat single-conversation
pilots as upper bounds, conv0 predicted +4.0 and the full set delivered +1.3.

**3. Multi-granularity memories (was item 1, still correct).** 74 failures with
partial gold overlap are set questions answered from a partial set. Session
summaries written as `semantic` memories at ingest put co-occurring facts in one
retrievable unit. Best structural bet, and unlike the graph routes it does not
depend on entity quality.

**4. Query decomposition for multi-hop.** Multi-hop is 38% of all remaining
failures. Split multi-part questions, retrieve per sub-query, merge pools.
Measure on the multi-hop slice with `run.ts` before believing it.

**5. Embedding sweep — still nearly free, still not done.** 512 dims was a
choice, not a measurement. conv0/conv1 retrieval-only at 512 / 1536 / 3072.

**6. Topic boosts have the same truncation bug entities had.**
`getByTopic(topic, 10)` with `topicScore = memories.length <= 3 ? 0.2 : 0.08`
saturates at the LIMIT exactly as the entity ladder did. One-line fix mirroring
`entityIdfWeight`; left undone only to keep the entity change attributable.

**7. Drop hub entities from the query side.** If a query extracts an entity that
sits on 80% of memories, it contributes nothing but candidate-pool noise. Same
IDF, other end of the pipeline.

### Recorded as done, do not redo

- **Interjection filtering** (`df672fd`): 40% of conv0 entity types and 19% of
  mentions were "Wow", "Hey Mel", "Thanks". General to any `Name: text` content.
- **IDF entity weighting** (`5c80bf0`): the old ladder read a LIMIT-20 result
  length, so an entity on 300 memories scored the same as one on 21.
- **Graph route** (`graphLimit`): measured at zero, see the section above. The
  cause is now understood — conv0's vault had 419 memories, 106 entities and
  **one edge**. There was no graph to traverse. Any future graph work must
  first show that edges exist.

## What NOT to do

- Don't chase mem0/Zep/Mnemis leaderboard numbers: they sit above our answering
  model's ceiling and their methodologies are incomparable (upstream's own 80%
  claim did not reproduce: 43.8% raw, 34.3% with its extraction pipeline).
- Don't move ingestion to extraction-only. Measured: −10 points.

## Measured since this was written (2026-08-18, Phase 3 dual-route work)

Notes added by the session that ran `docs/superpowers/plans/2026-08-17-phase3-dual-route-retrieval.md`.
Three of the items above now have numbers attached. Reproduce with
`bench/locomo/run.ts <conv> <topK> <graphLimit>` and `bench/locomo/e2e.ts`.

**Item 4 — spreading activation: its stated cut condition is now MET.**
The roadmap says "if graph-discovered candidates don't move multi-hop
recall@10, cut the complexity." They don't. `graphLimit` (`src/types.ts`,
`recallScored` step 9) reserves N slots that are APPENDED after the primary
slice, so graph hits never displace a ranked result. On conv0, at an equal
30-snippet budget:

```
  10 + 0  baseline                 recall 0.762   multi-hop 0.542
  30 + 0  more of the ranked list  recall 0.890   multi-hop 0.740
  10 + 20 slots to the graph       recall 0.761   multi-hop 0.534
```

Twenty slots spent on spreading activation recover **nothing** — the result is
the 10+0 baseline. The same slots spent on more of the ranked list recover 15
points. Mnemis's +15.3 for its graph route (System-1 RAG 73.8 -> RAG+Graph
89.1) does not reproduce here.

**Caveat that matters before anyone deletes code:** this was measured over
*rule-based* ingest. `bench/locomo/` builds its vaults with no LLM config, so
entity extraction is regex-grade and the edge set is nearly empty — there is
almost no graph to traverse. Item 4 and item 1 are therefore entangled: fixing
the substrate (session summaries, LLM extraction at ingest) could make the
route work. Cutting the mechanism now is defensible; concluding "graph
retrieval doesn't help" is not, until something has been retrieved over a real
graph.

The System-2 hierarchy (`src/hierarchy.ts`, `categories`/`category_edges`,
`engram hierarchy`, `hierarchy: false` on RecallInput) was built and unit-tested
but its e2e ablation was NOT run — it stands on the same rule-based substrate
that just measured at zero, and its LLM cost per query is the highest of
anything in the plan. Measure it only after item 1.

**Item 5 — the answer layer is confirmed as the biggest remaining lever.**
Oracle ceiling (`bench/locomo/oracle.ts`, answers built from gold evidence
only): **85.1%** overall, multi-hop 70.6. So 29.4 points of multi-hop failure
survive *perfect* retrieval — more than retrieval itself is worth. Causes seen
in the transcripts, in rough order of size: all-or-nothing judging of
enumerations ("Transgender" graded WRONG against "Transgender woman"; five of
six listed activities graded WRONG), the "Be concise — a few words" instruction
meeting six-item gold answers, and LoCoMo evidence labels that do not contain
their own gold answer ("What did Melanie paint recently?" -> gold "sunset",
oracle "Not mentioned"). Only the middle one is ours to fix.

**Correction (same day): the 85.1% is not an upper bound.** It was measured
under answer prompt v1 and against LoCoMo's evidence labels, both of which
leak. conv0's oracle is 82.0%; conv0 at top-30 with a rewritten answer prompt
(v2, `ENGRAM_BENCH_PROMPT=v2` in `bench/locomo/e2e.ts`) scores 84.9% — above
its own "ceiling". Two causes: the oracle inherited the v1 prompt defect it was
being used to diagnose, and the evidence labels omit answers that are present
in the conversation. Treat the oracle as an attribution tool (how much failure
survives good evidence), never as a bound on what retrieval may claim.

**A free +6.7 that was not on this list: the context budget itself.**
Same pipeline, `topK` 10 -> 30, no code change: **74.3% -> 81.0%** e2e
(multi-hop 44.3 -> 60.3, single-hop 82.9 -> 88.8, temporal 80.7 -> 84.4). That
captured 6.7 of the 10.8 points available below the ceiling before any of the
architecture above was involved. Worth stating plainly because it reframes the
rest: remaining headroom is ~4 points overall, ~10 on multi-hop, not ~20.
Open-domain is the exception and got *worse* (65.6 -> 61.5) — 20 extra
loosely-related snippets appear to dilute an inference-style question. Anyone
raising `topK` further should watch that category.

**Method note.** The cheap retrieval-only ablation that killed item 4 takes ~90
seconds on conv0 and costs embeddings only. The e2e runs it should have gated
cost ~3,100 chat calls and ~40 minutes each. Order future work by
cost-to-inform, not by the size of the reported gain being chased — run
`run.ts` first, always.

## Process discipline that made this work

Ablate on conv0/1 → confirm on a holdout conversation → let the oracle bound
what a retrieval change can claim. Every scoring change gets attributed to a
pipeline layer (diag-style ablation) before the code changes.
