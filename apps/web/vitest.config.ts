import path from 'node:path';
import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  test: {
    name: 'web',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['../../packages/db/src/testing/global-setup.ts'],
    setupFiles: ['./test/setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // F32: the WhatsApp number is not checked with Meta unless a test asks for it.
    env: { ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', WHATSAPP_MODE: 'mock' },
  },
});
