# Full-repo code review — 2026-08-16

Reviewed: entire codebase at HEAD `319238a` **plus** the uncommitted working-tree diff
(`src/vault.ts`, `src/store.ts`, `src/__tests__/retrieval-scoring.test.ts`).

**Test results:** `npx vitest run` → 1 failed | 234 passed. The failure
(`src/__tests__/router.test.ts:62` "truncates by score across stores, not by store order")
is introduced by the uncommitted diff — a snapshot of HEAD passes all router tests.
`npx tsc --noEmit` is clean.

**Verdict: HEAD is ready. The uncommitted diff must not be committed as-is.**

## Critical

### 1. `normaliseScores` rewrite breaks cross-store score comparability — `src/vault.ts:98-104` (uncommitted)

The new `score/(score+1)` saturation preserves *absolute* BM25 magnitude, but BM25 magnitude
is corpus-relative: IDF depends on each store's contents. Measured: `"linter"` scores **0.45**
where it's rare and **~1e-6** where it appears in every row. The router merges stores by raw
score (`src/router.ts:109-113`) under the documented invariant that "nothing in the scoring
pipeline is corpus-relative" (`docs/references/memory-scope-and-types.md:69-72`, repeated in
the `router.ts` header). The old min-max was per-result-set shape, so each store's best
lexical hit landed at the same scale; the new transform makes a strong match in a small
project store lose to a weaker match in a larger global store — exactly what
`router.test.ts:76` asserts against, and it now fails deterministically.

**Fix direction:** drop hits below an epsilon (~1e-4 — see issue 3), then normalise shape
within the result set (e.g. `score/max`). Any absolute-magnitude term reintroduces
corpus-relativity; if that trade is wanted, it must be made explicitly — rewrite the router
merge, `memory-scope-and-types.md`, and the test in the same commit.

## Important

### 2. Lexical-only vaults lose most of their scoring range — `src/vault.ts:98-104` (uncommitted)

Under the saturation, a typical single-term match tops out ~0.31, so a no-embedder vault's
best lexical base score is ~0.6 × 0.31 ≈ **0.19** — below the entity boost (0.25 + 0.1,
`vault.ts:765-768`), the broad-query fallback (0.3/0.35, `vault.ts:806-813`), and aggregation
boosts (0.3–0.4). Keyword relevance can be outvoted by heuristic boosts in the one mode where
it's the only real signal. Contradicts the `fuseRetrievalScores` docstring ("a vault with no
embedder still gets the full 0.6 ceiling from lexical search alone", `vault.ts:62-63`).

### 3. Zero-drop guard rests on a false premise — `src/vault.ts:100-102` (uncommitted)

FTS5 clamps IDF to ~1e-6, never exactly 0 (verified: a term present in every doc scores
~1.0e-6). `if (h.score > 0)` never fires on real stopword hits; the saturation is what
actually neutralizes them. The docstring's causal story and the new unit test ("drops
zero-score hits") both describe an input FTS5 cannot produce. Keep a drop-gate but make it an
epsilon (`score < 1e-4`) — which also enables the shape-normalisation fix for issue 1.

### 4. Multi-tenant auth bypass via prototype chain — `src/server.ts:692`

`config.vaults[apiKey]` with `Authorization: Bearer __proto__` (or `constructor`) resolves on
the prototype chain to a truthy value, so the tenant check passes and `getOrCreateRouter`
opens an unintended vault (`~/.engram/undefined.db`) with full read/write. Unreachable from
the shipped CLI (always sets `defaultVault`), but live for programmatic multi-tenant use.
**Fix:** `Object.hasOwn(config.vaults, apiKey)` or store tenants in a `Map`.

### 5. REST endpoints deviate from the merged-reads design — `src/server.ts:301-333, 377-386, 400-407`

`/v1/entities`, `/v1/stats`, `/v1/export`, `/v1/ask`, `/v1/alerts`, `/v1/consolidate` use
`router.vaultFor('global')` only, while the design doc mandates merged reads, name-merged
entities, per-scope stats, and both-store consolidation — and the router already implements
all of these (`router.entities()`, `.stats()`, `.ask()`, `.alerts()`, `.consolidate()`,
`.export()`). The in-code justification is backward compat, which this repo explicitly
rejects. Wire the router methods in, or amend the design doc.

### 6. `t.length > 2` drops 2-letter tech terms — `src/store.ts:834` (uncommitted)

"go", "ts", "js", "ci", "db", "ai" become unsearchable lexically while 3-letter stopwords
("the", "our", "was") still pass. A ~30-word explicit stoplist is barely more code and
strictly more precise — and once issue 1/3's epsilon gate exists, near-zero-IDF stopword hits
are neutralized anyway, likely making this filter redundant.

## Minor

- Stale comment: `fuseRetrievalScores` docstring still says BM25 scores "are min-max
  normalised" (`src/vault.ts:58-60`) — no longer true under the diff.
- `vitest.config.ts` excludes `.claude/**` but not the root `.worktrees/` directory —
  same double-collection failure mode commit 319238a fixed, one worktree away from recurring.
- `POST /v1/memories/recall` (body variant, `server.ts:221-227`) doesn't validate
  `body.scope` (invalid value silently returns `[]`; the GET variant validates). Malformed
  JSON bodies produce 500s instead of 400s; `readBody` has no size cap (auth-gated, low risk).
- `geminiEndpoint` puts the API key in the URL query string (`config.ts:23`) — leaks into
  proxy/access logs; the `x-goog-api-key` header avoids it.
- `router.move()` is non-atomic across two database files (`router.ts:355-363`): a crash
  between import and hard-forget leaves the memory in both stores. Acceptable for v0; worth a
  ceiling comment.
- Known follow-ups from the plan, confirmed still present: `surface()` uses the old flat
  `keywordSearch` (`vault.ts:2188`); `fts_built` is independent of `schema_version`
  (`store.ts:310-318`), so a future table rebuild would strand the FTS index on stale rowids.

## Strengths

- Plans 1–3 fully implemented and tested: `MemoryRouter` scope split, required `scope` on all
  MCP/REST writes, `engram_move` + `POST /v1/move` with edge-drop counting, `profile` type via
  transactional schema-v2 rebuild with `foreign_key_check` + rollback, scope labelling and
  precedence footer, git-commit capture hook, cross-scope `connect` rejection pointing at
  `engram_move`.
- Embedding-immutability constraint enforced exactly as documented (`src/store.ts:170-200`).
- Strong v0 security posture: mandatory bearer token, constant-time comparison, exact-origin
  CORS allowlist, parameterized SQL throughout, FTS5 query sanitization, secret-scrub on
  realtime ingest.
- Tests exercise real SQLite vaults, deterministic stub embedders, real HTTP servers — no
  mock theater.
- The committed cosine/L2 fix (189e289, 488350f) is correct; commit messages carry measured
  evidence.

## Recommendations

1. Do not commit the working-tree diff until `router.test.ts` passes. Fix issues 1–3
   together: epsilon drop-gate (~1e-4) + per-result-set shape normalisation.
2. Update the design doc's "no IDF anywhere" claim — technically false since BM25 landed
   (e68d2bd); min-max was what masked it.
3. Add a lexical-only end-to-end test: one no-embedder vault, a strong keyword match vs.
   entity-boosted noise. Current tests only exercise the fusion function in isolation, which
   is why issue 2 is invisible to the suite.
