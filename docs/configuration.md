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
| `ENGRAM_EMBEDDING_MODEL` | `gemini-embedding-001` | Keeps a default because the vector dimension is part of the SQLite schema. Change only on a fresh vault. |

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
