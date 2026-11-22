import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The workflow suite boots a Temporal dev server and bundles workflow code.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
