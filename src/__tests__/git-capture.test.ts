import { describe, it, expect } from 'vitest';
import { salienceForCommit } from '../git-capture.js';

describe('salienceForCommit', () => {
  it('scores features and fixes high', () => {
    expect(salienceForCommit('feat: add scope routing')).toBeGreaterThanOrEqual(0.6);
    expect(salienceForCommit('fix: correct merge ordering')).toBeGreaterThanOrEqual(0.6);
  });

  it('scores breaking changes highest', () => {
    expect(salienceForCommit('refactor!: drop the legacy vault'))
      .toBeGreaterThan(salienceForCommit('refactor: tidy imports'));
  });

  it('scores chores below the consolidation threshold', () => {
    expect(salienceForCommit('chore: bump deps')).toBeLessThan(0.2);
    expect(salienceForCommit('docs: fix typo')).toBeLessThan(0.2);
    expect(salienceForCommit('style: reformat')).toBeLessThan(0.2);
  });

  it('gives unconventional subjects a middling score', () => {
    const s = salienceForCommit('rewrote the whole retrieval path');
    expect(s).toBeGreaterThanOrEqual(0.2);
    expect(s).toBeLessThan(0.6);
  });
});
