import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { migrateLegacyVault } from '../config.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'engram-legacy-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('legacy vault migration', () => {
  it('renames default.db to global.db', () => {
    writeFileSync(join(dir, 'default.db'), 'PAYLOAD');
    expect(migrateLegacyVault(dir)).toBe('renamed');
    expect(existsSync(join(dir, 'default.db'))).toBe(false);
    expect(readFileSync(join(dir, 'global.db'), 'utf-8')).toBe('PAYLOAD');
  });

  it('carries the -wal and -shm sidecars across', () => {
    writeFileSync(join(dir, 'default.db'), 'DB');
    writeFileSync(join(dir, 'default.db-wal'), 'WAL');
    writeFileSync(join(dir, 'default.db-shm'), 'SHM');
    migrateLegacyVault(dir);
    expect(readFileSync(join(dir, 'global.db-wal'), 'utf-8')).toBe('WAL');
    expect(readFileSync(join(dir, 'global.db-shm'), 'utf-8')).toBe('SHM');
  });

  it('never overwrites an existing global.db', () => {
    writeFileSync(join(dir, 'default.db'), 'OLD');
    writeFileSync(join(dir, 'global.db'), 'CURRENT');
    expect(migrateLegacyVault(dir)).toBe('skipped');
    expect(readFileSync(join(dir, 'global.db'), 'utf-8')).toBe('CURRENT');
    expect(existsSync(join(dir, 'default.db'))).toBe(true);
  });

  it('is a no-op when there is nothing to migrate', () => {
    expect(migrateLegacyVault(dir)).toBe('skipped');
  });
});
