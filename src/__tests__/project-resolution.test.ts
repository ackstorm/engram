import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { resolveProject, resolveVaultPath, isSingleStoreMode } from '../config.js';

const KEYS = ['ENGRAM_PROJECT', 'ENGRAM_DB_PATH', 'ENGRAM_OWNER'] as const;
let saved: Record<string, string | undefined>;
let dir: string;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  dir = mkdtempSync(join(tmpdir(), 'engram-proj-'));
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveProject', () => {
  it('prefers ENGRAM_PROJECT', () => {
    process.env.ENGRAM_PROJECT = 'my-service';
    expect(resolveProject(dir)).toBe('my-service');
  });

  it('slugifies', () => {
    process.env.ENGRAM_PROJECT = 'My Service (v2)!';
    expect(resolveProject(dir)).toBe('my-service-v2');
  });

  it('uses the git repo basename from a nested directory', () => {
    const repo = join(dir, 'acme-gateway');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const nested = join(repo, 'src', 'deep');
    mkdirSync(nested, { recursive: true });
    expect(resolveProject(nested)).toBe('acme-gateway');
  });

  it('falls back to the cwd basename outside a repo', () => {
    const plain = join(dir, 'Scratch Dir');
    mkdirSync(plain, { recursive: true });
    expect(resolveProject(plain)).toBe('scratch-dir');
  });

  it('never returns empty', () => {
    expect(resolveProject('/')).toBe('default');
  });
});

describe('resolveVaultPath', () => {
  it('routes global and project to separate files', () => {
    const repo = join(dir, 'acme-gateway');
    mkdirSync(join(repo, '.git'), { recursive: true });
    expect(resolveVaultPath('global', repo)).toBe(join(homedir(), '.engram', 'global.db'));
    expect(resolveVaultPath('project', repo))
      .toBe(join(homedir(), '.engram', 'projects', 'acme-gateway.db'));
  });

  it('ENGRAM_DB_PATH collapses both scopes to one file', () => {
    process.env.ENGRAM_DB_PATH = '/tmp/one.db';
    expect(resolveVaultPath('global', dir)).toBe('/tmp/one.db');
    expect(resolveVaultPath('project', dir)).toBe('/tmp/one.db');
    expect(isSingleStoreMode()).toBe(true);
  });

  it('ENGRAM_OWNER collapses both scopes to the legacy path', () => {
    process.env.ENGRAM_OWNER = 'jarvis';
    const legacy = join(homedir(), '.engram', 'jarvis.db');
    expect(resolveVaultPath('global', dir)).toBe(legacy);
    expect(resolveVaultPath('project', dir)).toBe(legacy);
    expect(isSingleStoreMode()).toBe(true);
  });

  it('is two-store by default', () => {
    expect(isSingleStoreMode()).toBe(false);
  });
});
