# Three run modes — embedded, server, client

- `engram mcp` — embedded: MCP tools + vaults + dream scheduler in one
  process. SQLite analogy: the library IS the database.
- `engram serve` — daemon: REST API (`/v1/*`) + dream scheduler; the sole DB
  owner for remote setups. Auth is mandatory (`ENGRAM_AUTH_TOKEN`).
- `engram client` — thin MCP: identical tool surface, handlers proxy to a
  remote `engram serve` via `RemoteBackend`. No DB, no scheduler, no API keys
  on the client machine.

Key seams:
- `src/backend.ts` — `EngramBackend`, the async tool surface. MCP tools are
  written against it; `MemoryRouter` satisfies it directly (local), and
  `src/backend-remote.ts` satisfies it over REST. Adding a tool = extend
  `BackendMethods`, add the REST route, add the RemoteBackend method.
- `src/scheduler.ts` — the dream. Leased via `engram_meta` in the global
  vault so two processes on one vault can't double-consolidate. Replaced the
  old auto-consolidation hack inside `engram_briefing`.
- Filesystem-bound tools (the obsidian and claude-code imports) refuse to run
  in client mode — they belong on the host that owns the data. `engram_ingest`
  is exempt: it takes raw text, not files, so it works over REST.
