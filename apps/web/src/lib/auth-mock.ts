/**
 * The e2e tests mock the signed-in user (`AUTH_MOCK_USER="kp_e2e:admin@demo.test"`). It works:
 *  - only with AUTH_MOCK_USER set and, in a production build, ALLOW_AUTH_MOCK=true as well;
 *  - F34: and only when the panel's own address (KINDE_SITE_URL) is this machine, so even with both
 *    variables set by mistake a deployed panel never skips the sign-in.
 * Pure (no Kinde, no server-only): used by the proxy and by `server/auth.ts`.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function authMockAllowed(env: Record<string, string | undefined> = process.env): boolean {
  if (!env.AUTH_MOCK_USER) return false;
  if (env.NODE_ENV === 'production' && env.ALLOW_AUTH_MOCK !== 'true') return false;
  try {
    return LOCAL_HOSTS.has(new URL(env.KINDE_SITE_URL ?? '').hostname);
  } catch {
    return false;
  }
}
