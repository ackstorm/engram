# Embedding configuration is immutable per vault

**Status:** permanent architectural constraint of the SQLite/sqlite-vec design.
**Applies to:** `MODEL_PROVIDER`, `ENGRAM_EMBEDDING_MODEL`, `ENGRAM_EMBEDDING_DIMS`.

## The constraint

Once a vault has been created with embeddings, its **embedding dimension is
frozen for the life of that database file**. Changing the provider, the model,
or the dimension afterwards is not a configuration change — it invalidates
every vector already stored.

## Why

`src/store.ts` creates the vector index as a `sqlite-vec` virtual table with the
dimension baked into the column type:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
  memory_id TEXT PRIMARY KEY,
  embedding float[${this.embeddingDimensions}]
);
```

Two consequences follow:

1. **The width is part of the schema.** A `float[3072]` column cannot hold a
   1536-dimension vector.
2. **`IF NOT EXISTS` makes the failure silent.** Reopening an existing 3072-wide
   vault with a 1536-dimension embedder does *not* recreate the table. The old
   table survives at the old width and subsequent writes go wrong.

Vectors are also mirrored in `memories.embedding BLOB`, which has no width
constraint at all — so a mismatch can persist there undetected.

Even at an identical dimension, **switching models is still destructive in
practice**: vectors from two different models are not comparable. Cosine
similarity between a `gemini-embedding-001` vector and a
`text-embedding-3-small` vector is noise, so recall silently degrades rather
than erroring.

### Provider defaults

| Provider | Default model | Dimensions |
|---|---|---|
| `gemini` | `gemini-embedding-001` | 3072 |
| `openai` | `text-embedding-3-small` | 1536 |

Switching `MODEL_PROVIDER` between these two therefore always changes the width.

## The guard

`MemoryStore`'s constructor records the dimension in `engram_meta` on first
creation and throws on mismatch at open time:

```
[engram] Vault at <path> was built with 3072-dimension embeddings but the
current configuration produces 1536. Changing embedding model or
MODEL_PROVIDER invalidates every stored vector.
```

This converts silent corruption into a startup failure. It does **not** make the
change safe — it makes it visible.

## Migrating deliberately

There is no in-place re-embed, and **no importer for Engram's own export
format**. `vault.export()` (`src/vault.ts:2275`) returns
`{ memories, edges, entities }`, but `engram import` (`src/cli.ts:1082`) only
handles Obsidian and Claude Code sources. A restore is a script you write:

1. Open the old vault with the **old** embedding settings, call `export()`,
   write the JSON to disk.
2. Point `ENGRAM_DB_PATH` at a **new** file and configure the new provider.
3. Replay `memories` through `vault.remember()` — this re-embeds each one with
   the new model.
4. Replay `edges` through `vault.connect(sourceId, targetId, type, strength)`.
   Memory IDs are preserved by `remember()` only if you pass them explicitly;
   otherwise build an old-ID → new-ID map during step 3 and translate.
5. Run `vault.backfillEmbeddings()` to catch anything skipped.

Budget the embedding API cost of re-embedding the entire vault.

## Practical guidance

- **Decide the provider before the vault has content.** This is the cheapest
  possible moment to choose.
- **Set `ENGRAM_EMBEDDING_MODEL` and `ENGRAM_EMBEDDING_DIMS` together** or not at
  all. Setting one without the other produces a vault whose stored width does
  not match what the model returns.
- **Pin the values in `docker-compose.yml`** rather than leaving them to
  inference from whichever API key happens to be present — key-based inference
  means adding an `OPENAI_API_KEY` to an existing Gemini deployment can flip the
  provider.
- **A vault is not portable across providers.** Treat `~/.engram/*.db` as
  coupled to the embedding configuration that produced it.

## Related gap

There is no `engram export` → `engram restore` round trip. Writing one (~30
lines over `export()`, `remember()`, and `connect()`) would make provider
migration, backups, and vault merges all routine. Currently none of the three
are.
