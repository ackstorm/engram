import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/** Drive the MCP server over stdio and return every JSON-RPC frame. */
function mcpCall(env: Record<string, string>, ...messages: unknown[]) {
  const input = messages.map(m => JSON.stringify(m)).join('\n') + '\n';
  const r = spawnSync('npx', ['tsx', 'src/mcp.ts'], {
    input,
    encoding: 'utf-8',
    timeout: 120_000,
    // ALLOW_NO_EMBEDDER: these assert tool schemas, not retrieval quality.
    // Without it they depend on an API key being present in the shell.
    env: { ...process.env, ENGRAM_ALLOW_NO_EMBEDDER: '1', ...env },
  });
  const frames = r.stdout.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  return { frames, stderr: r.stderr };
}

describe('MCP server uses the router', () => {
  it('advertises engram_move and requires scope on engram_remember', () => {
    const dir = mkdtempSync(join(tmpdir(), 'engram-mcp-router-'));
    mkdirSync(join(dir, 'proj', '.git'), { recursive: true });
    try {
      const { frames } = mcpCall(
        { HOME: dir, ENGRAM_PROJECT: 'testproj' },
        { jsonrpc: '2.0', id: 1, method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      );

      const list = frames.find(f => f.id === 2);
      expect(list).toBeDefined();
      const tools: any[] = list.result.tools;
      const names = tools.map(t => t.name);

      expect(names).toContain('engram_move');

      const remember = tools.find(t => t.name === 'engram_remember');
      expect(remember.inputSchema.properties.scope).toBeDefined();
      expect(remember.inputSchema.required).toContain('scope');
      expect(remember.inputSchema.required).toContain('content');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires scope on every write tool', () => {
    const dir = mkdtempSync(join(tmpdir(), 'engram-scope-req-'));
    try {
      const { frames } = mcpCall(
        { HOME: dir, ENGRAM_PROJECT: 'testproj' },
        { jsonrpc: '2.0', id: 1, method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      );
      const tools: any[] = frames.find(f => f.id === 2).result.tools;
      for (const name of [
        'engram_remember', 'engram_ingest', 'engram_checkpoint',
        'engram_import_obsidian', 'engram_import_claude_code',
      ]) {
        const tool = tools.find(t => t.name === name);
        expect(tool, `${name} should exist`).toBeDefined();
        expect(tool.inputSchema.required, `${name} must require scope`).toContain('scope');
        expect(tool.inputSchema.properties.scope.enum).toEqual(['project', 'global']);
      }
      // Read-only tools must NOT require it.
      const audit = tools.find(t => t.name === 'engram_audit');
      expect(audit.inputSchema.required ?? []).not.toContain('scope');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
