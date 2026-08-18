// ============================================================
// RemoteBackend — EngramBackend over the /v1 REST API
// ============================================================
// Used by `engram client`: the machine running the MCP holds no DB, no
// embedder, and no LLM keys; everything lives behind `engram serve`.

import type { EngramBackend } from './backend.js';
import type { MemoryRouter } from './router.js';

export class RemoteBackend implements EngramBackend {
  constructor(private readonly baseUrl: string, private readonly token: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private async call(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`engram server ${res.status} on ${method} ${path}: ${(await res.text()).slice(0, 200)}`);
    }
    return res.json();
  }

  async remember(scope: any, input: any) {
    const payload = typeof input === 'string' ? { content: input } : input;
    return this.call('POST', '/v1/memories', { scope, ...payload });
  }

  async recall(input: any) {
    const payload = typeof input === 'string' ? { context: input } : input;
    return (await this.call('POST', '/v1/memories/recall', payload)).memories;
  }

  async getById(id: string) {
    return this.call('GET', `/v1/memories/${encodeURIComponent(id)}`);
  }

  async forget(id: string, hard = false) {
    const body = await this.call('DELETE', `/v1/memories/${encodeURIComponent(id)}?hard=${hard}`);
    return body === null
      ? { found: false, fullId: null }
      : { found: true, fullId: body.deleted };
  }

  async updateMemoryById(id: string, updates: any) {
    return this.call('PATCH', `/v1/memories/${encodeURIComponent(id)}`, updates);
  }

  async neighbors(id: string, depth = 1) {
    const body = await this.call('GET', `/v1/memories/${encodeURIComponent(id)}/neighbors?depth=${depth}`);
    return body.memories ?? body.neighbors;
  }

  async entities() {
    return (await this.call('GET', '/v1/entities')).entities;
  }

  async ask(question: string, opts?: { limit?: number; spread?: boolean }) {
    return this.call('POST', '/v1/ask', { question, ...opts });
  }

  async briefing(context = '', limit = 20) {
    return this.call('POST', '/v1/briefing', { context, limit });
  }

  async alerts(opts?: { staleDays?: number; limit?: number; includeContradictions?: boolean }) {
    const params = new URLSearchParams();
    if (opts?.staleDays !== undefined) params.set('staleDays', String(opts.staleDays));
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
    const qs = params.toString();
    const body = await this.call('GET', `/v1/alerts${qs ? `?${qs}` : ''}`);
    return body.alerts;
  }

  async surface(input: any) {
    const body = await this.call('POST', '/v1/surface', input);
    return body.surfaced;
  }

  async contradictions(limit = 50) {
    return (await this.call('GET', `/v1/contradictions?limit=${limit}`)).contradictions;
  }

  /**
   * The route reshapes the router's `{ saved: Memory[], extracted, deduplicated }`
   * into `{ extracted, deduplicated, saved: <count>, memories: <preview[]> }` —
   * reassemble the interface's shape from `memories` (see src/server.ts's
   * POST /v1/checkpoint handler).
   */
  async checkpoint(
    scope: any,
    summary: string,
    opts?: { maxMemories?: number; label?: string },
  ) {
    const body = await this.call('POST', '/v1/checkpoint', { scope, summary, ...opts });
    return {
      saved: body.memories,
      extracted: body.extracted,
      deduplicated: body.deduplicated,
    } as Awaited<ReturnType<MemoryRouter['checkpoint']>>;
  }

  async audit(content: string, opts?: { maxClaims?: number; relevanceThreshold?: number }) {
    return this.call('POST', '/v1/audit', { content, ...opts });
  }

  async stats() {
    return this.call('GET', '/v1/stats');
  }

  async consolidate(opts?: { since?: string | Date; all?: boolean }) {
    return this.call('POST', '/v1/consolidate', opts);
  }

  async connect(sourceId: string, targetId: string, type: any, strength = 0.5) {
    return this.call('POST', '/v1/connections', { sourceId, targetId, type, strength });
  }

  async move(id: string, to: any) {
    return this.call('POST', '/v1/move', { id, scope: to });
  }

  async export() {
    return this.call('POST', '/v1/export', {});
  }

  async backfillEmbeddings() {
    return (await this.call('POST', '/v1/embeddings/backfill', {})).backfilled;
  }

  async close() { /* nothing held open */ }
}
