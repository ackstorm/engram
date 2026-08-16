// ============================================================
// Result formatting for MCP tool output
// ============================================================
//
// Edges cannot span vaults, so cross-scope precedence cannot be expressed in
// the graph. It is expressed here instead: every hit carries its scope, and a
// mixed result set carries the rule. This output is guaranteed to be in
// context when the agent weighs two conflicting rules — the SKILL.md is not.

import type { ScopedMemory } from './router.js';

const PRECEDENCE_NOTE =
  'Note: project-scoped memories take precedence over global ones where they conflict.';

export function formatScopedResults(memories: ScopedMemory[]): string {
  if (memories.length === 0) return 'No relevant memories found.';

  const lines = memories.map((m, i) =>
    `[${i + 1}] [${m.scope} · ${m.type}] salience=${m.salience.toFixed(2)} status=${m.status}\n` +
    `${m.content}\n` +
    `Entities: ${m.entities.join(', ') || 'none'} | Topics: ${m.topics.join(', ') || 'none'}`,
  );

  const scopes = new Set(memories.map(m => m.scope));
  const footer = scopes.size > 1 ? `\n\n${PRECEDENCE_NOTE}` : '';

  return `Found ${memories.length} memories:\n\n${lines.join('\n\n')}${footer}`;
}
