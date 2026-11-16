import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/shared', 'packages/db', 'apps/bot', 'apps/web'],
    // Stopping the embedded PostgreSQL used by DB tests can take a while on Windows.
    teardownTimeout: 60_000,
  },
});
