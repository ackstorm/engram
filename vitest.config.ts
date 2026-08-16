import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Worktrees under .claude/ contain full copies of the suite; without this
    // vitest collects them and reports failures from a stale checkout.
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'],
  },
});
