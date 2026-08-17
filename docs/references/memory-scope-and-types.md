# Memory scope and types — design

**Status:** agreed 2026-08-16. Implemented across plans 1–3.

How Engram decides *what kind* of memory something is and *where it lives*, and why the
two are separate questions.

## The two axes

Scope and type are orthogonal. Conflating them was the first draft's mistake: making
`profile` a type implied "personal" was a type, which left a personal *event* with nowhere
to go.

|  | **project** | **global** |
|---|---|---|
| **episodic** | the deploy failed Tuesday on cert renewal | last week you tried pomodoro and dropped it |
| **semantic** | this repo uses pnpm, not npm | the company standardises on GitLab |
| **procedural** | how to cut a release for this service | always run the linter before committing |
| **profile** | *(rare — a role held only here)* | prefers TypeScript, wants concise answers |

All eight cells are legal. `profile × project` is thin but not forbidden.

`profile` is a distinct type rather than a scope because scope cannot express it: "the
company uses GitLab" and "Juan Carlos prefers TypeScript" are both global facts, but only
one is about the person. Both the taxonomy Greyling describes and the more common
episodic/semantic/procedural/profile split draw that same line inside factual knowledge.

## Storage: two databases

```
~/.engram/global.db              scope = global
~/.engram/projects/<slug>.db     scope = project, one file per project
```

Scope is **physical**, not a column. The model is the CLAUDE.md precedent: a project
`./CLAUDE.md` and a user `~/.claude/CLAUDE.md`, separate at rest, both loaded at read
time.

`<slug>` resolves as: `ENGRAM_PROJECT` → basename of the enclosing git repository →
basename of the working directory, lowercased and non-alphanumerics collapsed to `-`.
This works because MCP hosts spawn one server process per project with the project
directory as its cwd — verified on Claude Code, where three concurrent user-scoped
`context7-mcp` processes each carried a different project cwd. `ENGRAM_PROJECT` takes
precedence because that behaviour is unverified on other hosts.

**Precedence order:** `ENGRAM_DB_PATH` (explicit file) → `ENGRAM_OWNER` (legacy flat
layout, `~/.engram/<owner>.db`) → per-project.

### What two databases cost

Recorded so nobody re-litigates it by accident:

- `edges` are foreign keys into `memories` in the same file, with
  `PRAGMA foreign_keys = ON`. A cross-store edge is rejected by SQLite, not merely
  discouraged.
- Therefore `supersedes` and `contradicts` **cannot span scopes**. Cross-scope precedence
  is not deferred, it is unrepresentable. This is permanent, not a "for now".
- Consolidation cannot promote a memory between scopes, for the same reason.
- A global structured view over *all* memory is impossible, which forecloses the
  hierarchical-traversal retrieval described in Plan 3 as spanning both stores.

The compensation is presentational precedence (below) and merged reads.

## Reads: both stores, merged

`recall` and every other read default to reading both stores and merging.

Merging is a plain concatenate-and-sort. Most of the pipeline is per-memory and so
corpus-independent: salience, stability, type bonus, confidence and recency are all
properties of the memory itself. One embedding configuration (process-global,
env-derived) means both stores share a vector space, so the semantic component is
directly comparable too.

**The lexical component is the exception.** BM25 weights each term by inverse document
frequency, so the same word scores differently depending on how common it is *in that
store* — measured, "linter" scores 0.45 where it is rare and ~1e-6 where it appears in
every row. A strong match in a small project store can therefore lose to a weaker match
in a larger global store.

This is bounded rather than fixed. At the default `ENGRAM_HYBRID_ALPHA` of 0.9 the
lexical component is 10% of a 0.6 primary score — at most 0.06 of swing — and embeddings
are mandatory, so the semantic component always dominates. The exception is a vault run
with `ENGRAM_ALLOW_NO_EMBEDDER=1`, where lexical is the entire signal and the merge is
fully corpus-relative. Do not run a two-store deployment that way.

Removing the exception outright means normalising BM25 within each result set, which
trades this problem for a worse one: a store holding nothing relevant would still promote
its least-bad hit to full marks. See the rejected-changes table in `eval/README.md`.

Each store runs at the **full** `limit`; the merged list is truncated afterwards.
Allocating the limit per-store beforehand would starve whichever store holds the better
answers.

Two mechanical exceptions to "read both":

- **By-ID operations** (`getMemoryById`, `forget`, `updateMemoryById`) resolve across both
  stores and act on whichever matches.
- **`neighbors`** stays inside the store owning the starting memory, because edges do not
  cross.

`entities` merges by name and sums counts. `stats` reports per-scope rather than merged.

## Writes: explicit and required

`scope` is a **required** enum on `remember`, `ingest`, `checkpoint`, and both importers,
in MCP and REST alike. Not optional-with-a-default: a required schema field is enforced by
the MCP layer and fails loudly, whereas a documented convention is an instruction
competing for attention in a context window.

The evidence for that choice is in this codebase. `vault.ts:1976` reads:

```ts
// Sanitize type — LLMs sometimes return invalid types like "correction" or "fact"
```

The extractor is already constrained by a three-value Zod enum and still returns values
outside it often enough that someone wrote a sanitiser. That is the base rate for "the
model will classify correctly because we told it to."

`audit` is read-only and takes no scope. `connect` resolves both IDs across both stores
and fails with a message naming each ID's scope when they differ, pointing at
`engram_move`.

## Precedence: presentational

Because the graph cannot express cross-scope precedence, the agent applies it. Every
recall hit is labelled with its scope:

```
[1] [project · semantic] salience=0.80 status=active
```

When a result set spans both scopes, one line is appended:

> Project-scoped memories take precedence over global ones where they conflict.

The same rule appears in the shipped SKILL.md, but the output line is the load-bearing
copy — it is guaranteed to be in context at the moment the agent weighs two conflicting
rules. No automatic conflict detection: comparing every global result against every
project result is expensive, and the agent judges semantic conflict better than a
heuristic would.

## Repair: `engram_move`

With two files and explicit targeting, a mis-targeted write is otherwise permanent —
there is no importer for Engram's own export format. `engram_move({ id, scope })` makes
the error rate survivable.

One embedding configuration means the stored vector is valid in the destination as-is, so
a move is a copy rather than a re-embed. It preserves id, embedding, timestamps, access
count and stability. Edges are dropped, because their other end may not be moving, and the
tool **reports how many were dropped** so the loss is visible. Moving an edge-bearing
memory is allowed — refusing would make the repair path unusable exactly when it is
needed.

## Consolidation

Both stores, sequentially, each within itself, with per-scope figures in the `--json`
output. Personal episodes maturing into personal semantic memories matters as much as the
project case.

## Automatic project capture

A Claude Code `PostToolUse` hook matching `Bash(git commit*)`, installed by `engram init`
alongside the existing `Stop` hook. It captures agent-authored commits, where the
in-session reasoning is.

Content is the commit subject plus changed paths, as `episodic`, `scope: project`.
Salience derives from the conventional-commit type — `feat`/`fix`/`refactor!` high,
`chore`/`docs`/`style` low — and anything below 0.2 is skipped, which is the threshold
`consolidate()` already filters on. This matters because nothing in Engram decays:
`memoriesDecayed: 0` is a hardcoded literal at `vault.ts:1136`, so noise admitted here is
permanent.

No LLM call on the diff: it would put a network round-trip in the commit path, and the
message usually already says why.

A real `.git/hooks/pre-push` was considered and rejected — per-clone, unversioned,
invisible to teammates, and it writes into the user's repository.

## Migration

- No migration from `~/.engram/default.db`. Pre-fork installs are treated as version 0 —
  no backward compatibility is maintained across this redesign. Users on the old single
  vault start fresh with `~/.engram/global.db` / `~/.engram/projects/<slug>.db`.
- Adding `profile` requires a full SQLite table rebuild, because `memories.type` carries
  `CHECK(type IN ('episodic','semantic','procedural'))` and SQLite cannot alter a CHECK
  constraint. Since the rebuild is unavoidable, the constraint is **dropped** rather than
  extended: Zod's `MemoryType` already validates every write, and removing it makes future
  taxonomy changes migration-free.

## Retrieval quality (Plan 3 scope)

Informed by *Mnemis: Dual-Route Retrieval on Hierarchical Graphs for Long-Term LLM Memory*
(Microsoft, ACL 2026), whose ablation on LoCoMo with GPT-4.1-mini reads:

| Configuration | Overall |
|---|---|
| episodes only | 73.8 |
| entities + edges only | 81.6 |
| episodes + entities + edges | 89.1 |
| the above plus a Qwen3-8B re-ranker | 89.1 |
| hierarchical traversal only | 87.7 |
| both routes combined | 93.3 |

Three conclusions carried into the plans:

1. **Do not build a re-ranking stage.** 89.1 → 89.1. Swapping an 8B re-ranker for a 0.6B
   one costs 0.7 points. The gain attributed to re-ranking is not there.
2. **Fix keyword search first** (folded into Plan 1). `keywordSearch` assigns a flat score
   per keyword hit with no IDF or length normalisation. FTS5 with BM25 is compiled into
   Node's bundled SQLite — verified, version 3.53.1 — so this needs no dependency. Fuse
   with the vector results using Reciprocal Rank Fusion rather than score addition.
3. **The remaining headroom is structural retrieval.** Engram's spreading activation
   already has the right intuition but the wrong direction: it spreads outward from
   similarity-derived seeds, so it can only reach what is adjacent to something it already
   found. Top-down traversal from a category hierarchy reaches memories no seed pointed
   at. That is where the +4.2 lives, and it is also expensive — Mnemis reports 1.39×10⁷
   prompt tokens and 3,873 seconds to build the hierarchy for LoCoMo, with periodic
   rebuilds.

## Implementation shape

A new `MemoryRouter` holds two `Vault` instances and owns all dual-store logic — merged
reads, targeted writes, cross-store ID resolution, move. `Vault` itself stays
single-store and unmodified; it is 2,700 lines and there is no reason for it to learn
about scope.

- **Plan 1 — storage:** table rebuild and `profile`, project resolution, `MemoryRouter`,
  `engram_move`, cross-store `connect` error, FTS5/BM25 + RRF.
- **Plan 2 — surface:** required `scope` across MCP and REST, scope labelling and the
  precedence footer, `SKILL.md`, the `PostToolUse` git hook, docs.
- **Plan 3 — retrieval quality:** per-field embeddings, an extraction reflection pass, and
  the hierarchical category graph.
