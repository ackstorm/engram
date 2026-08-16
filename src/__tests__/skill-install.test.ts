import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

describe('shipped skill', () => {
  it('exists with valid frontmatter', () => {
    const p = join(process.cwd(), 'skills/engram-memory/SKILL.md');
    expect(existsSync(p)).toBe(true);
    const body = readFileSync(p, 'utf-8');
    expect(body.startsWith('---')).toBe(true);
    expect(body).toMatch(/^name: engram-memory$/m);
    expect(body).toMatch(/^description: /m);
  });

  it('documents the precedence rule and both scopes', () => {
    const body = readFileSync(join(process.cwd(), 'skills/engram-memory/SKILL.md'), 'utf-8');
    expect(body).toContain('engram_move');
    expect(body).toMatch(/project/i);
    expect(body).toMatch(/global/i);
  });
});
