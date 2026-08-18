// ============================================================
// EngramBackend — one tool surface, two transports
// ============================================================
//
// The MCP tools are written against this type, not MemoryRouter, so the
// same tool definitions can run embedded (direct function calls) or as a
// thin client (REST calls to a remote `engram serve`). Every method is
// Promise-returning because the remote implementation has no choice;
// `await` on the local side's synchronous returns is free.

import type { MemoryRouter } from './router.js';

/** The router methods the MCP tools use. Extend here when adding tools. */
type BackendMethods =
  | 'remember' | 'recall' | 'getById' | 'forget' | 'updateMemoryById'
  | 'neighbors' | 'entities' | 'ask' | 'briefing' | 'alerts' | 'surface'
  | 'contradictions' | 'checkpoint' | 'audit' | 'stats' | 'consolidate'
  | 'connect' | 'move' | 'export' | 'backfillEmbeddings' | 'close';

type Asyncify<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : T[K];
};

export type EngramBackend = Asyncify<Pick<MemoryRouter, BackendMethods>>;

/**
 * The local backend IS the router: `await` flattens its synchronous returns,
 * so the cast is a type-level statement, not a runtime wrapper.
 */
export function localBackend(router: MemoryRouter): EngramBackend {
  return router as unknown as EngramBackend;
}
