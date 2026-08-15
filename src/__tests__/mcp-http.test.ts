import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ============================================================
// engram-mcp --http must never start unauthenticated
// ============================================================

describe('MCP HTTP transport startup', () => {
  it('refuses to start without ENGRAM_AUTH_TOKEN', () => {
    const dir = mkdtempSync(join(tmpdir(), 'engram-mcp-http-'));
    try {
      const env = { ...process.env, ENGRAM_DB_PATH: join(dir, 'test.db') };
      delete env.ENGRAM_AUTH_TOKEN;

      const result = spawnSync('npx', ['tsx', 'src/mcp.ts', '--http'], {
        encoding: 'utf-8',
        timeout: 60_000,
        env,
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('ENGRAM_AUTH_TOKEN');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('starts in stdio mode without a token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'engram-mcp-stdio-'));
    try {
      const env = {
        ...process.env,
        ENGRAM_DB_PATH: join(dir, 'test.db'),
        ENGRAM_SESSIONS_DIR: join(dir, 'no-sessions'),
      };
      delete env.ENGRAM_AUTH_TOKEN;

      const result = spawnSync('npx', ['tsx', 'src/mcp.ts'], {
        input: '',
        encoding: 'utf-8',
        timeout: 60_000,
        env,
      });

      expect(result.stderr).toContain('Engram MCP server running');
      // Issue #9 regression: stdout stays clean.
      expect(result.stdout.trim()).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
