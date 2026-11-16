import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'db',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globalSetup: ['./src/testing/global-setup.ts'],
    // Test files share one database: run them sequentially.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
