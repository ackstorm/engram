# Configuration

Every runtime knob is an environment variable. Nothing is read from a config file.

## Required

| Variable | Applies to | Notes |
|---|---|---|
| `ENGRAM_AUTH_TOKEN` | `engram-serve`, `engram-mcp --http` | Bearer token. Both refuse to start without it. stdio MCP does not use it. Generate with `openssl rand -hex 32`. |
| `ENGRAM_LLM_MODEL` | anything that calls an LLM | No default. An unset model is a startup error rather than a guess. |

## LLM and embeddings

Engram speaks one protocol: the OpenAI-compatible `/v1/embeddings` and
`/v1/chat/completions` endpoints. Native Gemini and Anthropic clients were
removed. To use a Gemini or Claude model, point the base URL at a gateway that
proxies it (LiteLLM, vLLM, OpenRouter, Vertex AI's compatibility layer) — the
model name is then whatever that gateway calls it.

| Variable | Default | Notes |
|---|---|---|
| `OPENAI_API_KEY` | — | Key for embeddings. Also the fallback key for chat. |
| `OPENAI_BASE_URL` | `https://api.openai.com` | API **root**, not the versioned path — Engram appends `/v1/embeddings` itself, so `https://host/v1` produces `/v1/v1/embeddings` and 404s. |
| `ENGRAM_LLM_API_KEY` | `OPENAI_API_KEY` | Separate key for chat, when the two live behind different credentials. |
| `ENGRAM_LLM_BASE_URL` | `https://api.openai.com` | API root for chat. |
| `ENGRAM_EMBEDDING_MODEL` | `text-embedding-3-small` | |
| `ENGRAM_EMBEDDING_DIMS` | the model's native width | Falls back to `1536` for an unrecognised model. Sent as the OpenAI `dimensions` parameter only when explicitly set — some gateways reject it. |
| `ENGRAM_ALLOW_NO_EMBEDDER` | unset | `1` permits starting with no embedding key. Recall then runs keyword-only, which measures roughly half the accuracy. |
| `MODEL_PROVIDER` | unset | Accepted only as `openai`. Any other value is a startup error, so a leftover `MODEL_PROVIDER=gemini` fails loudly rather than sending a Gemini key to an OpenAI endpoint. |

Changing the embedding model or dimension on an existing vault is rejected at
startup: the dimension is recorded in `engram_meta` and every stored vector
depends on it. Point `ENGRAM_DB_PATH` at a new file and re-import instead.

## Network

| Variable | Default | Notes |
|---|---|---|
| `ENGRAM_HOST` | `127.0.0.1` | `engram-serve` bind address. |
| `ENGRAM_PORT` | `0` (random) | `engram-serve` port. |
| `ENGRAM_MCP_HOST` | `127.0.0.1` | `engram-mcp --http` bind address. |
| `ENGRAM_MCP_PORT` | `3801` | `engram-mcp --http` port. |
| `ENGRAM_CORS_ORIGIN` | empty | Comma-separated **exact** origins. Empty means no `Access-Control-Allow-Origin` header at all. `*` is honoured but disables the protection. No prefix matching: `http://localhost` does not admit `http://localhost.evil.com`. |

## Storage

| Variable | Default | Notes |
|---|---|---|
| `ENGRAM_DB_PATH` | `~/.engram/<owner>.db` | Collapses both scopes onto one file — see Memory scope below. |
| `ENGRAM_OWNER` | `default` | Same single-store collapse as `ENGRAM_DB_PATH`. |
| `ENGRAM_PROJECT` | enclosing git repo basename, then cwd basename | Names the project vault under `~/.engram/projects/`. |
| `ENGRAM_SESSIONS_DIR` | `~/.engram/sessions` | |
| `ENGRAM_INGEST_INTERVAL_MS` | `300000` | |

## Memory scope

Memory lives in two SQLite files, not one — mirroring `~/.claude/CLAUDE.md`
(you) and `./CLAUDE.md` (this repo). Design rationale:
[`docs/references/memory-scope-and-types.md`](references/memory-scope-and-types.md).

| Store | Path | Holds |
|---|---|---|
| global | `~/.engram/global.db` | preferences, traits, company-wide rules — true regardless of codebase |
| project | `~/.engram/projects/<project>.db` | this repo's conventions, architecture, incidents |

`<project>` resolves in order: `ENGRAM_PROJECT` env var, the enclosing git
repo's basename, then the current directory's basename. MCP hosts spawn one
server process per project with the project directory as cwd, which is what
makes the git-root/cwd fallback meaningful.

Every write tool (`engram_remember`, `engram_ingest`, `engram_checkpoint`,
`engram_import_obsidian`, `engram_import_claude_code`, and the REST
equivalents) **requires** an explicit `scope: 'project' | 'global'` — there
is no default. `engram_recall` and `GET/POST /v1/memories/recall` accept an
*optional* `scope` to narrow a search to one store; omitting it searches
both and merges results by relevance, labelled `[scope · type]`.

Stored something in the wrong place? `engram_move({ id, scope })` (or
`POST /v1/move`) relocates it. Connections to other memories are dropped in
the process — edges are SQLite foreign keys within one file and cannot span
stores.

**Single-store fallback.** Setting `ENGRAM_DB_PATH` or `ENGRAM_OWNER`
collapses both scopes onto one file — the pre-fork daemon layout. `scope` is
still required on writes for API consistency, but every write lands in the
same store regardless of which scope you pass.
