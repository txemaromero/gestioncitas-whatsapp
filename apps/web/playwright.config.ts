import { defineConfig, devices } from '@playwright/test';

/**
 * Smoke e2e of the admin panel with mocked auth (AUTH_MOCK_USER, server-side only).
 * Requires a production build (`pnpm build:web`) and a PostgreSQL server
 * (default: the embedded one from `pnpm db:local`). The database `clinicai_e2e` is recreated.
 */
const PORT = Number(process.env.E2E_PORT ?? 3100);
export const E2E_SERVER_URL = process.env.E2E_PG_SERVER_URL ?? 'postgresql://postgres:postgres@localhost:5433/postgres';
const databaseUrl = E2E_SERVER_URL.replace(/\/[^/]*$/, '/clinicai_e2e');
/** F19: local-only password of the restricted role (same as `pnpm db:app-role`). */
export const E2E_APP_ROLE_PASSWORD = 'clinicai_app_local';
const appDatabaseUrl = (() => {
  const url = new URL(databaseUrl);
  url.username = 'clinicai_app';
  url.password = E2E_APP_ROLE_PASSWORD;
  return url.toString();
})();

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: 'es-ES',
    timezoneId: 'Europe/Madrid',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec next start -p ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DATABASE_URL: databaseUrl,
      DATABASE_APP_URL: appDatabaseUrl,
      AUTH_MOCK_USER: 'kp_e2e_admin:admin@e2e.test',
      ALLOW_AUTH_MOCK: 'true',
      // F31: the e2e user is also a platform administrator.
      PLATFORM_ADMIN_EMAILS: 'admin@e2e.test',
      ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      KINDE_CLIENT_ID: 'e2e',
      KINDE_CLIENT_SECRET: 'e2e',
      KINDE_ISSUER_URL: 'https://example.kinde.com',
      KINDE_SITE_URL: `http://localhost:${PORT}`,
      KINDE_POST_LOGOUT_REDIRECT_URL: `http://localhost:${PORT}`,
      KINDE_POST_LOGIN_REDIRECT_URL: `http://localhost:${PORT}/dashboard`,
    },
  },
});
