import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ============================================================
// `engram init` must never build a shell command string
// ============================================================
//
// It used to register with Claude Code via
//   execSync(['claude','mcp','add','-s','user',...envArgs,'--',...].join(' '))
// where envArgs interpolated ENGRAM_OWNER straight from --owner. Anything the
// shell treats as a separator therefore ran as a command.
//
// The payload writes a file. If a shell ever evaluates it, the file exists and
// this test fails — which is a stronger signal than asserting on output.

describe('engram init argument handling', () => {
  it('does not evaluate --owner through a shell', () => {
    const dir = mkdtempSync(join(tmpdir(), 'engram-init-safety-'));
    const canary = join(dir, 'pwned');
    try {
      // Trailing `#` matters: the vulnerable build appended the remaining
      // flags after the injected command, so a bare `; touch <path>` became
      // `touch <path> -e PATH=... -- engram ...`, which GNU touch rejects.
      // The payload ran and still created nothing — a test without the
      // comment marker passes against vulnerable code.
      const result = spawnSync(
        'npx',
        ['tsx', 'src/cli.ts', 'init', '--owner', `x; touch ${canary} #`],
        {
          encoding: 'utf-8',
          timeout: 120_000,
          // HOME redirected so init writes its configs into the temp dir
          // rather than the developer's real ~/.claude and ~/.cursor.
          env: { ...process.env, HOME: dir, ENGRAM_ALLOW_NO_EMBEDDER: '1' },
        },
      );

      expect(existsSync(canary)).toBe(false);
      // Also assert it ran rather than dying early, or the check above passes
      // for the wrong reason.
      expect(result.stdout).toContain('Engram Setup');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not evaluate backticks or $() in --owner', () => {
    const dir = mkdtempSync(join(tmpdir(), 'engram-init-safety-'));
    const canary = join(dir, 'subshell');
    try {
      spawnSync('npx', ['tsx', 'src/cli.ts', 'init', '--owner', `$(touch ${canary})`], {
        encoding: 'utf-8',
        timeout: 120_000,
        env: { ...process.env, HOME: dir, ENGRAM_ALLOW_NO_EMBEDDER: '1' },
      });
      expect(existsSync(canary)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
