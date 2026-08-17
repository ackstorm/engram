// ============================================================
// Capture agent-authored commits as project memories
// ============================================================
//
// Nothing in Engram decays — consolidate() reports memoriesDecayed: 0 as a
// hardcoded literal — so noise admitted here is permanent. Salience is derived
// from the conventional-commit type and anything below 0.2 is dropped, which
// is the threshold consolidate() already filters on.

import { execFileSync } from 'child_process';
import { MemoryRouter } from './router.js';

const SALIENCE: Record<string, number> = {
  feat: 0.7, fix: 0.7, perf: 0.6, refactor: 0.5, revert: 0.6,
  test: 0.3, build: 0.3, ci: 0.3,
  chore: 0.1, docs: 0.1, style: 0.1,
};

export function salienceForCommit(subject: string): number {
  const match = /^([a-z]+)(\([^)]*\))?(!)?:/i.exec(subject.trim());
  if (!match) return 0.4;                       // unconventional — assume it matters somewhat
  const base = SALIENCE[match[1].toLowerCase()] ?? 0.4;
  return match[3] ? Math.min(base + 0.2, 1) : base;   // '!' marks a breaking change
}

interface PostToolUsePayload {
  tool_name?: string;
  tool_input?: { command?: string };
  cwd?: string;
}

/**
 * Read a Claude Code PostToolUse hook payload from stdin and, if it wraps a
 * `git commit`, store the commit as a project-scoped episodic memory.
 * Silent no-op for anything else — most Bash calls aren't commits.
 */
export async function captureCommit(input: string): Promise<void> {
  let payload: PostToolUsePayload;
  try {
    payload = JSON.parse(input);
  } catch {
    return;
  }

  const command = payload.tool_input?.command ?? '';
  if (!/\bgit\s+commit\b/.test(command)) return;

  const cwd = payload.cwd ?? process.cwd();
  const opts = { cwd, encoding: 'utf-8' as const };

  let subject: string;
  let changedFiles: string[];
  try {
    subject = execFileSync('git', ['log', '-1', '--pretty=%s'], opts).trim();
    changedFiles = execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], opts)
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch {
    return; // not a git repo, or no commits yet — nothing to capture
  }
  if (!subject) return;

  const salience = salienceForCommit(subject);
  if (salience < 0.2) return;

  const router = MemoryRouter.open(cwd);
  try {
    router.remember('project', {
      content: changedFiles.length > 0
        ? `${subject}\n\nFiles changed: ${changedFiles.join(', ')}`
        : subject,
      type: 'episodic',
      topics: ['commit'],
      salience,
    });
  } finally {
    await router.close();
  }
}
