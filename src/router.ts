// ============================================================
// MemoryRouter — two stores behind one API
// ============================================================
//
// Scope is physical: a global vault and a per-project vault, mirroring
// ~/.claude/CLAUDE.md and ./CLAUDE.md. Writes are explicitly targeted; reads
// merge both. Vault itself stays single-store and knows nothing about scope.
//
// Merging is a plain concatenate-and-sort because nothing in the scoring
// pipeline is corpus-relative (no IDF, no collection-size normalisation) and
// both stores share one embedding configuration, so scores are comparable.

import { Vault } from './vault.js';
import { createEmbedder } from './embeddings.js';
import {
  type MemoryScope,
  resolveVaultPath,
  isSingleStoreMode,
  resolveLlmConfig,
} from './config.js';
import type {
  Memory, Edge, Entity, RememberInput, RecallInput, ConsolidationReport, AskResult,
} from './types.js';

// Memory.scope is a vestigial, disjoint field ('local'|'hosted'|'both') left over
// from the old routing design — unrelated to MemoryScope. Omit it so the two
// don't collide into `never`.
export type ScopedMemory = Omit<Memory, 'scope'> & { scope: MemoryScope };

export interface ScopedRecallInput extends RecallInput {
  /** Which store(s) to read. Omitted means both. */
  scope?: MemoryScope;
}

export class MemoryRouter {
  constructor(
    private readonly globalVault: Vault,
    /** null in single-store mode, where everything lives in globalVault. */
    private readonly projectVault: Vault | null,
  ) {}

  /** Build a router from the environment. */
  static open(cwd?: string): MemoryRouter {
    const embedder = createEmbedder();
    const llm = resolveLlmConfig();
    const globalVault = new Vault(
      { owner: 'global', dbPath: resolveVaultPath('global', cwd), ...(llm ? { llm } : {}) },
      embedder,
    );
    if (isSingleStoreMode()) {
      console.warn(
        '[engram] Single-store mode (ENGRAM_DB_PATH or ENGRAM_OWNER is set): ' +
        'project-scoped writes will be stored alongside global ones.',
      );
      return new MemoryRouter(globalVault, null);
    }
    const projectVault = new Vault(
      { owner: 'project', dbPath: resolveVaultPath('project', cwd), ...(llm ? { llm } : {}) },
      embedder,
    );
    return new MemoryRouter(globalVault, projectVault);
  }

  /** The store backing a scope. Falls back to global in single-store mode. */
  vaultFor(scope: MemoryScope): Vault {
    if (scope === 'global' || !this.projectVault) return this.globalVault;
    return this.projectVault;
  }

  /** Every live store, paired with the scope label its rows carry. */
  private stores(): Array<{ scope: MemoryScope; vault: Vault }> {
    const list: Array<{ scope: MemoryScope; vault: Vault }> = [
      { scope: 'global', vault: this.globalVault },
    ];
    if (this.projectVault) list.push({ scope: 'project', vault: this.projectVault });
    return list;
  }

  // ── Writes ────────────────────────────────────────────────

  remember(scope: MemoryScope, input: RememberInput | string): ScopedMemory {
    const stored = this.vaultFor(scope).remember(input);
    return { ...stored, scope: this.projectVault ? scope : 'global' };
  }

  // ── Reads ─────────────────────────────────────────────────

  async recall(input: ScopedRecallInput | string): Promise<ScopedMemory[]> {
    const parsed: ScopedRecallInput =
      typeof input === 'string' ? { context: input } : input;
    const targets = parsed.scope
      ? this.stores().filter(s => s.scope === parsed.scope)
      : this.stores();

    // Each store runs at the FULL limit; truncation happens after the merge.
    // Splitting the budget beforehand would starve whichever store holds the
    // better answers.
    const perStore = await Promise.all(
      targets.map(async ({ scope, vault }) => {
        const { scope: _drop, ...vaultInput } = parsed;
        const hits = await vault.recallScored(vaultInput as RecallInput);
        return hits.map(h => ({ memory: { ...h.memory, scope } as ScopedMemory, score: h.score }));
      }),
    );

    // Sort across stores before truncating. Concatenating and slicing would
    // return whichever store happens to be first, regardless of relevance.
    const limit = parsed.limit ?? 10;
    return perStore
      .flat()
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(r => r.memory);
  }

  getById(id: string): ScopedMemory | null {
    for (const { scope, vault } of this.stores()) {
      const found = vault.getMemoryById(id);
      if (found) return { ...found, scope };
    }
    return null;
  }

  forget(id: string, hard = false): { found: boolean; fullId: string | null; scope?: MemoryScope } {
    for (const { scope, vault } of this.stores()) {
      const result = vault.forget(id, hard);
      if (result.found) return { ...result, scope };
    }
    return { found: false, fullId: null };
  }

  /** Graph traversal stays inside the owning store — edges never cross. */
  neighbors(id: string, depth = 1): ScopedMemory[] {
    for (const { scope, vault } of this.stores()) {
      if (!vault.getMemoryById(id)) continue;
      return vault.neighbors(id, depth).map(m => ({ ...m, scope }) as ScopedMemory);
    }
    return [];
  }

  entities(): Entity[] {
    const byName = new Map<string, Entity>();
    for (const { vault } of this.stores()) {
      for (const entity of vault.entities()) {
        const existing = byName.get(entity.name);
        if (!existing) {
          byName.set(entity.name, { ...entity });
          continue;
        }
        existing.memoryCount += entity.memoryCount;
        existing.importance = Math.max(existing.importance, entity.importance);
      }
    }
    return [...byName.values()].sort((a, b) => b.memoryCount - a.memoryCount);
  }

  /**
   * ask() synthesizes one LLM answer from one vault's own recall — it cannot
   * accept externally-merged candidates. Running it on every store and
   * picking the richer answer as primary (folding the other's sources in as
   * supporting evidence) is the closest approximation without reworking
   * Vault.ask() to take pre-fetched memories.
   */
  async ask(question: string, opts?: { limit?: number; spread?: boolean }): Promise<AskResult> {
    const results = await Promise.all(
      this.stores().map(async ({ scope, vault }) => ({
        scope,
        ...await vault.ask(question, opts),
      })),
    );
    const rank = { high: 2, medium: 1, low: 0 } as const;
    const [primary, ...rest] = results.sort(
      (a, b) => rank[b.confidence] - rank[a.confidence] || b.sources.length - a.sources.length,
    );
    const extraSources = rest.flatMap(r => r.sources.map(s => ({ ...s, scope: r.scope })));
    return {
      ...primary,
      sources: [...primary.sources.map(s => ({ ...s, scope: primary.scope })), ...extraSources],
      reasoning: extraSources.length > 0
        ? `${primary.reasoning ?? ''} (${extraSources.length} more source(s) found in the other scope.)`.trim()
        : primary.reasoning,
    };
  }

  async briefing(context = '', limit = 20): Promise<Awaited<ReturnType<Vault['briefing']>>> {
    const parts = await Promise.all(this.stores().map(({ vault }) => vault.briefing(context, limit)));
    const [first, ...rest] = parts;
    const merged = rest.reduce((acc, p) => {
      acc.summary += `\n${p.summary}`;
      acc.keyFacts.push(...p.keyFacts);
      acc.recentChanges.push(...p.recentChanges);
      acc.activeCommitments.push(...p.activeCommitments);
      acc.recentActivity.push(...p.recentActivity);
      acc.contradictions.push(...p.contradictions);
      for (const [entity, facts] of Object.entries(p.clusteredFacts)) {
        (acc.clusteredFacts[entity] ??= []).push(...facts);
      }
      return acc;
    }, first);
    merged.topEntities = this.entities().slice(0, 20);
    return merged;
  }

  alerts(opts?: {
    staleDays?: number;
    limit?: number;
    includeContradictions?: boolean;
  }): ReturnType<Vault['alerts']> {
    const limit = opts?.limit ?? 10;
    const priority = { high: 2, medium: 1, low: 0 } as const;
    return this.stores()
      .flatMap(({ vault }) => vault.alerts(opts))
      .sort((a, b) => priority[b.priority] - priority[a.priority] || a.ageDays - b.ageDays)
      .slice(0, limit);
  }

  async surface(input: Parameters<Vault['surface']>[0]): Promise<Array<{
    memory: ScopedMemory; reason: string; relevance: number; activationPath: string;
  }>> {
    const limit = input.limit ?? 3;
    const results = await Promise.all(
      this.stores().map(async ({ scope, vault }) =>
        (await vault.surface(input)).map(r => ({ ...r, memory: { ...r.memory, scope } as ScopedMemory })),
      ),
    );
    return results
      .flat()
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, limit);
  }

  /** Contradictions never cross stores — edges can't — so this just concatenates, tagging each with its store. */
  contradictions(limit = 50): Array<ReturnType<Vault['contradictions']>[number] & { scope: MemoryScope }> {
    return this.stores().flatMap(({ scope, vault }) =>
      vault.contradictions(limit).map(c => ({ ...c, scope })),
    );
  }

  /** Checkpoints are session context for one place in time — they target one store, chosen by the caller. */
  async checkpoint(
    scope: MemoryScope,
    summary: string,
    opts?: { maxMemories?: number; label?: string },
  ): Promise<Awaited<ReturnType<Vault['checkpoint']>>> {
    return this.vaultFor(scope).checkpoint(summary, opts);
  }

  /** Audits both stores against the same external content and merges the discrepancies found. */
  async audit(
    content: string,
    opts?: { maxClaims?: number; relevanceThreshold?: number },
  ): Promise<Awaited<ReturnType<Vault['audit']>>> {
    const results = await Promise.all(this.stores().map(({ vault }) => vault.audit(content, opts)));
    return results.reduce((acc, r) => ({
      discrepancies: [...acc.discrepancies, ...r.discrepancies],
      verified: acc.verified + r.verified,
      total: Math.max(acc.total, r.total),
    }));
  }

  async backfillEmbeddings(): Promise<number> {
    const counts = await Promise.all(this.stores().map(({ vault }) => vault.backfillEmbeddings()));
    return counts.reduce((a, b) => a + b, 0);
  }

  stats(): { global: ReturnType<Vault['stats']>; project?: ReturnType<Vault['stats']> } {
    return {
      global: this.globalVault.stats(),
      ...(this.projectVault ? { project: this.projectVault.stats() } : {}),
    };
  }

  async consolidate(
    options?: { since?: string | Date; all?: boolean },
  ): Promise<Record<MemoryScope, ConsolidationReport | null>> {
    const out: Record<string, ConsolidationReport | null> = { global: null, project: null };
    await Promise.all(
      this.stores().map(async ({ scope, vault }) => {
        out[scope] = await vault.consolidate(options);
      }),
    );
    return out as Record<MemoryScope, ConsolidationReport | null>;
  }

  async close(): Promise<void> {
    for (const { vault } of this.stores()) await vault.close();
  }

  /**
   * Edges are foreign keys within one file, so a cross-store edge is rejected
   * by SQLite itself. Fail earlier, with a message the agent can act on.
   */
  connect(sourceId: string, targetId: string, type: Edge['type'], strength = 0.5): Edge {
    const source = this.getById(sourceId);
    const target = this.getById(targetId);
    if (!source) throw new Error(`[engram] No memory found for sourceId "${sourceId}".`);
    if (!target) throw new Error(`[engram] No memory found for targetId "${targetId}".`);
    if (source.scope !== target.scope) {
      throw new Error(
        `[engram] Cannot connect across scopes: "${sourceId}" is ${source.scope} and ` +
        `"${targetId}" is ${target.scope}. Edges cannot span vaults. Use engram_move to ` +
        'bring one into the other scope first.',
      );
    }
    return this.vaultFor(source.scope).connect(sourceId, targetId, type, strength);
  }

  /**
   * Re-home a memory. Both stores share one embedding configuration, so the
   * stored vector stays valid and is carried across as-is rather than
   * recomputed. Edges cannot follow — their other end may not be moving — so
   * they are dropped and counted.
   */
  move(id: string, to: MemoryScope): { moved: boolean; from?: MemoryScope; edgesDropped: number } {
    const found = this.getById(id);
    if (!found) return { moved: false, edgesDropped: 0 };
    if (found.scope === to || !this.projectVault) {
      return { moved: false, from: found.scope, edgesDropped: 0 };
    }

    const source = this.vaultFor(found.scope);
    const edgesDropped = source.edgeCount(id);
    const { scope: _drop, ...memory } = found;

    const destination = this.vaultFor(to);
    destination.importMemory(memory as Memory);
    const vector = source.getEmbeddingVector(id);
    if (vector) destination.storeEmbeddingVector(id, vector);
    source.forget(id, true);

    return { moved: true, from: found.scope, edgesDropped };
  }
}
