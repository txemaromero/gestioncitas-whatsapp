import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'bot',
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    globalSetup: ['../../packages/db/src/testing/global-setup.ts'],
    setupFiles: ['./test/setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: {
      LOG_LEVEL: 'silent',
    },
  },
});
