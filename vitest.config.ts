import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Worktrees contain full copies of the suite; without this vitest collects
    // them and reports failures from a stale checkout. Both locations are
    // listed because worktrees have been created in each.
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**', '.worktrees/**'],
  },
});
