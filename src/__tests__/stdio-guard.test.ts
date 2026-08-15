import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';

// ============================================================
// Issue #9 — stray stdout writes corrupt the MCP JSON-RPC stream
// ============================================================

describe('stdio guard', () => {
  it('keeps console noise off stdout and leaves stdout valid JSON', () => {
    const fixture = join(process.cwd(), 'src/__tests__/fixtures/noisy-entry.ts');
    const result = spawnSync('npx', ['tsx', fixture], {
      encoding: 'utf-8',
      timeout: 60_000,
    });

    expect(result.status).toBe(0);

    // Nothing but the deliberate JSON-RPC frame may reach stdout.
    const stdoutLines = result.stdout.split('\n').filter(l => l.trim());
    expect(stdoutLines).toHaveLength(1);
    for (const line of stdoutLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }

    // The noise is not lost — it is redirected to stderr.
    expect(result.stderr).toContain('LOG_NOISE');
    expect(result.stderr).toContain('INFO_NOISE');
    expect(result.stderr).toContain('DEBUG_NOISE');
    expect(result.stderr).toContain('ERROR_NOISE');
  });
});
