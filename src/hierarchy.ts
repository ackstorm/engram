// ============================================================
// Hierarchical category graph (Mnemis System-2, build side)
// ============================================================
//
// Layer 0 is the existing `entities` table — no LLM call. Each layer above is
// produced by one prompt over the layer below. The constraints in the prompt
// are load-bearing, quoted from the Mnemis appendix (arXiv:2602.15313):
//
//   - nodes are referred to BY INDEX, never by name, or the model rewrites
//     them and mapping back becomes guesswork;
//   - "The category name MUST NOT include the word 'and' as a connector" —
//     forces atomic categories, so "Food and Drinks" becomes two;
//   - tags: "maximum 3 words, maximum 5 descriptors";
//   - many-to-many: a node may belong to several categories, which is what
//     lets retrieval reach it from different angles;
//   - "There must be NO leftover or ungrouped nodes";
//   - "'user' and any first-person references ('I','me') MUST be categorized
//     into one category called 'Speaker'".
//
// Compression: "each category must contain at least n child nodes" and "each
// upper layer must contain no more nodes than the layer beneath it". Building
// stops the moment either is violated — an uncompressed layer is a rename, not
// an abstraction, and it costs a traversal round at query time forever after.
//
// Cost is the dominant constraint here, not correctness. Mnemis reports
// 1.39e7 prompt tokens and 3,873s to build this for LoCoMo. On a laptop-local
// tool that is a rebuild you schedule, never something on the write path.

import { randomUUID } from 'crypto';
import type { MemoryStore } from './store.js';

const BUILD_PROMPT = (nodes: string[]) => `You are organising a memory graph into semantic categories.

Below is a numbered list of nodes. Group them into categories.

RULES — all mandatory:
- Refer to nodes ONLY by their number. Never rewrite a node's text.
- A category name MUST NOT contain the word "and" as a connector. Split it into
  two categories instead.
- Give each category at most 5 tags, each at most 3 words.
- A node MAY belong to more than one category.
- There must be NO leftover or ungrouped nodes: every number appears at least once.
- Any node that is "user", "I", or "me" MUST go into a single category named "Speaker".
- Categories must be specific enough to stay informative. Prefer "Pottery" over "Activities".

NODES:
${nodes.map((n, i) => `${i}. ${n}`).join('\n')}

Respond as JSON only:
{"categories": [{"name": "...", "tags": ["..."], "children": [0, 3, 7]}]}`;

interface ParsedCategory { name: string; tags: string[]; children: number[] }

/** Extract the first JSON object and validate it into categories. Never throws. */
function parseCategories(raw: string, nodeCount: number): ParsedCategory[] {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(match[0]); } catch { return []; }
  const list = (parsed as { categories?: unknown }).categories;
  if (!Array.isArray(list)) return [];

  const out: ParsedCategory[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { name, tags, children } = entry as Record<string, unknown>;
    if (typeof name !== 'string' || !name.trim()) continue;
    // The "and" rule is enforced here, not just asked for: a model that
    // ignores it would otherwise poison every layer above.
    if (/\band\b/i.test(name)) continue;
    if (!Array.isArray(children)) continue;
    const kids = children
      .filter((c): c is number => Number.isInteger(c) && c >= 0 && c < nodeCount);
    if (kids.length === 0) continue;
    const tagList = Array.isArray(tags)
      ? tags.filter((t): t is string => typeof t === 'string')
          .slice(0, 5)
          .map(t => t.trim().split(/\s+/).slice(0, 3).join(' '))
      : [];
    out.push({ name: name.trim(), tags: tagList, children: [...new Set(kids)] });
  }
  return out;
}

/**
 * Build the category layers over the vault's entities, bottom-up.
 *
 * Destructive and idempotent: clears any existing hierarchy first, because a
 * partial rebuild would leave edges pointing at categories from a previous
 * corpus. Mnemis does the same, and says so — "we periodically rebuild the
 * hierarchical graph for simplicity".
 *
 * Never throws. A failed or unparseable layer stops the build and leaves
 * whatever layers already succeeded, because a shorter hierarchy is usable and
 * a thrown error loses the ones that worked.
 */
export async function buildHierarchy(
  store: MemoryStore,
  chat: (prompt: string) => Promise<string>,
  opts: { maxLayers?: number; minChildren?: number } = {},
): Promise<{ layers: number; categories: number }> {
  const maxLayers = opts.maxLayers ?? 3;
  const minChildren = opts.minChildren ?? 2;

  store.clearCategories();

  // Layer 0: entity names, free.
  let below: Array<{ id: string; label: string }> =
    store.getAllEntityNames().map(name => ({ id: name, label: name }));
  let belowKind: 'entity' | 'category' = 'entity';
  let layers = 0;
  let categories = 0;

  for (let layer = 1; layer <= maxLayers; layer++) {
    if (below.length < 2) break;

    let raw: string;
    try {
      raw = await chat(BUILD_PROMPT(below.map(n => n.label)));
    } catch {
      break;
    }

    const parsed = parseCategories(raw, below.length)
      .filter(c => c.children.length >= minChildren);

    // Compression constraint: an upper layer must be strictly smaller than the
    // one below, or it is a rename rather than an abstraction.
    if (parsed.length === 0 || parsed.length >= below.length) break;

    const created: Array<{ id: string; label: string }> = [];
    for (const cat of parsed) {
      const id = randomUUID();
      store.insertCategory({ id, name: cat.name, tags: cat.tags, layer });
      for (const idx of cat.children) {
        store.linkCategoryChild(id, below[idx].id, belowKind);
      }
      created.push({ id, label: `${cat.name} [${cat.tags.join(', ')}]` });
      categories++;
    }

    layers = layer;
    below = created;
    belowKind = 'category';
  }

  return { layers, categories };
}

// The selection prompt is Mnemis's NODE_SELECTION_PROMPT_TEMPLATE, adapted to
// select by name rather than by uuid — uuids waste tokens and the model has no
// use for them when names within a layer are unique. Its released selector
// defaults use_tag=True and use_summary=False, so tags are shown and summaries
// are not. Note the deliberately permissive wording: this route exists to widen
// coverage, and a strict selector would just reproduce the vector search.
const SELECTION_PROMPT = (query: string, nodes: Array<{ name: string; tags: string[] }>) =>
  `You are analyzing a hierarchical knowledge graph to help answer a user query.

Select all nodes that could help answer the query. A node is helpful if it:
- Directly relates to the query;
- Covers a clearly relevant topic, concept, or category;
- Provides useful background or context;
- Contains user-specific information (e.g. interests, goals, constraints);
- Likely has sub-nodes that may be helpful.

Do not be overly strict: include nodes that might provide context or
personalization, even if they seem partially redundant.

Set "get_all_children" to true only if you are confident ALL of a node's
sub-nodes are helpful.

QUERY: ${query}

NODES:
${nodes.map(n => `- ${n.name} [${n.tags.join(', ')}]`).join('\n')}

Respond as JSON only:
{"selected": [{"name": "...", "get_all_children": false}]}`;

/** Parse the selector's reply into names. Never throws. */
function parseSelection(raw: string): Array<{ name: string; all: boolean }> {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(match[0]); } catch { return []; }
  const list = (parsed as { selected?: unknown }).selected;
  if (!Array.isArray(list)) return [];
  const out: Array<{ name: string; all: boolean }> = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { name, get_all_children } = entry as Record<string, unknown>;
    if (typeof name !== 'string' || !name.trim()) continue;
    out.push({ name: name.trim(), all: get_all_children === true });
  }
  return out;
}

/** Every entity reachable beneath these categories, following edges downward. */
function allDescendantEntities(store: MemoryStore, rootIds: string[]): string[] {
  const entities = new Set<string>();
  let frontier = rootIds;
  const seen = new Set(rootIds);
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const edge of store.getCategoryChildren(frontier)) {
      if (edge.childKind === 'entity') { entities.add(edge.childId); continue; }
      if (seen.has(edge.childId)) continue;
      seen.add(edge.childId);
      next.push(edge.childId);
    }
    frontier = next;
  }
  return [...entities];
}

/**
 * Mnemis's System-2 Global Selection: descend the hierarchy from the top,
 * asking the model at each layer which categories are relevant, and collect
 * the entities underneath.
 *
 * Results are UNORDERED. Mnemis says so explicitly, and it is why traversal
 * output cannot join a reciprocal-rank fusion — there are no ranks to fuse.
 * Callers must spend it as extra coverage, the way `graphLimit` does.
 *
 * Never throws: an empty array means "this route contributed nothing", which
 * is a valid outcome on a vault with no hierarchy built.
 */
export async function selectByTraversal(
  store: MemoryStore,
  query: string,
  chat: (prompt: string) => Promise<string>,
): Promise<string[]> {
  const top = store.getMaxCategoryLayer();
  if (top < 1) return [];

  const entities = new Set<string>();
  let current = store.getCategoriesByLayer(top);

  for (let layer = top; layer >= 1 && current.length > 0; layer--) {
    let raw: string;
    try {
      raw = await chat(SELECTION_PROMPT(query, current));
    } catch {
      break;
    }

    const byName = new Map(current.map(c => [c.name.toLowerCase(), c]));
    const shortcut: string[] = [];
    const descend: string[] = [];
    for (const sel of parseSelection(raw)) {
      const cat = byName.get(sel.name.toLowerCase());
      if (!cat) continue;                       // the model invented a name
      (sel.all ? shortcut : descend).push(cat.id);
    }

    // The shortcut: "set true only if you're confident all its sub-nodes are
    // helpful" — take the whole subtree without spending a call per layer.
    for (const e of allDescendantEntities(store, shortcut)) entities.add(e);

    if (descend.length === 0) break;

    const children = store.getCategoryChildren(descend);
    for (const edge of children) {
      if (edge.childKind === 'entity') entities.add(edge.childId);
    }
    const nextIds = new Set(children.filter(c => c.childKind === 'category').map(c => c.childId));
    current = store.getCategoriesByLayer(layer - 1).filter(c => nextIds.has(c.id));
  }

  return [...entities];
}
