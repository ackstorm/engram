import { describe, it, expect } from 'vitest';
import { formatScopedResults } from '../mcp-format.js';

const mem = (scope: 'project' | 'global', content: string) => ({
  id: 'm_' + content.slice(0, 4), scope, type: 'semantic', content,
  salience: 0.5, status: 'active', entities: [], topics: [],
}) as any;

describe('formatScopedResults', () => {
  it('labels each result with scope and type', () => {
    const out = formatScopedResults([mem('project', 'uses pnpm')]);
    expect(out).toContain('[project · semantic]');
    expect(out).toContain('uses pnpm');
  });

  it('appends the precedence note when results span both scopes', () => {
    const out = formatScopedResults([
      mem('global', 'always run the linter'),
      mem('project', 'run pnpm lint here'),
    ]);
    expect(out).toContain('take precedence');
  });

  it('omits the note when results are single-scope', () => {
    expect(formatScopedResults([mem('project', 'only project')])).not.toContain('take precedence');
    expect(formatScopedResults([mem('global', 'only global')])).not.toContain('take precedence');
  });

  it('handles an empty result set', () => {
    expect(formatScopedResults([])).toContain('No relevant memories');
  });
});
