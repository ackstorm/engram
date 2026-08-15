# Configuration

Every runtime knob is an environment variable. Nothing is read from a config file.

## Required

| Variable | Applies to | Notes |
|---|---|---|
| `ENGRAM_AUTH_TOKEN` | `engram-serve`, `engram-mcp --http` | Bearer token. Both refuse to start without it. stdio MCP does not use it. Generate with `openssl rand -hex 32`. |
| `ENGRAM_LLM_MODEL` | anything that calls an LLM | No default. An unset model is a startup error rather than a guess. |

## LLM and embeddings

| Variable | Default | Notes |
|---|---|---|
| `ENGRAM_LLM_PROVIDER` | — | `gemini`, `openai`, or `anthropic`. |
| `ENGRAM_LLM_API_KEY` | falls back to `GEMINI_API_KEY` | |
| `ENGRAM_LLM_BASE_URL` | provider default | OpenAI-compatible endpoints (Groq, Cerebras, Ollama). |
| `GOOGLE_GEMINI_BASE_URL` | `https://generativelanguage.googleapis.com` | Reroutes **all** Gemini traffic — LLM calls and embeddings alike. Trailing slashes are stripped. |
| `MODEL_PROVIDER` | inferred from whichever API key is set | `openai` or `gemini`. Selects the **embedding** provider only; the LLM provider is `ENGRAM_LLM_PROVIDER`. |
| `OPENAI_BASE_URL` | `https://api.openai.com` | Any OpenAI-compatible embeddings endpoint. |
| `ENGRAM_EMBEDDING_MODEL` | `gemini-embedding-001` / `text-embedding-3-small` | Per-provider default. |
| `ENGRAM_EMBEDDING_DIMS` | `3072` / `1536` | Per-provider default. Sent as the OpenAI `dimensions` parameter only when explicitly set. |

Changing the embedding model, dimension, or `MODEL_PROVIDER` on an existing
vault is rejected at startup: the dimension is recorded in `engram_meta` and
every stored vector depends on it. Point `ENGRAM_DB_PATH` at a new file and
re-import instead.

## Network

| Variable | Default | Notes |
|---|---|---|
| `ENGRAM_HOST` | `127.0.0.1` | `engram-serve` bind address. |
| `ENGRAM_PORT` | `0` (random) | `engram-serve` port. |
| `ENGRAM_MCP_HOST` | `127.0.0.1` | `engram-mcp --http` bind address. |
| `ENGRAM_MCP_PORT` | `3801` | `engram-mcp --http` port. |
| `ENGRAM_CORS_ORIGIN` | empty | Comma-separated **exact** origins. Empty means no `Access-Control-Allow-Origin` header at all. `*` is honoured but disables the protection. No prefix matching: `http://localhost` does not admit `http://localhost.evil.com`. |

## Storage

| Variable | Default |
|---|---|
| `ENGRAM_DB_PATH` | `~/.engram/<owner>.db` |
| `ENGRAM_OWNER` | `default` |
| `ENGRAM_SESSIONS_DIR` | `~/.engram/sessions` |
| `ENGRAM_INGEST_INTERVAL_MS` | `300000` |
