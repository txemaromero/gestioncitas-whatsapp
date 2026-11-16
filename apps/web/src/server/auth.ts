import 'server-only';
import { getKindeServerSession } from '@kinde-oss/kinde-auth-nextjs/server';
import { authMockAllowed } from '@/lib/auth-mock';

export interface AuthUser {
  /** Kinde user id (`kp_…`, the token `sub`). */
  id: string;
  email: string | null;
  /** F32: `email_verified` of the Kinde ID token; only a verified email grants anything (identity.ts). */
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

/**
 * Auth bypass ONLY for automated e2e tests: `AUTH_MOCK_USER="kp_e2e:admin@demo.test"`, under the
 * conditions of `lib/auth-mock.ts` (never set these variables in Netlify).
 */
export function getMockUser(): AuthUser | null {
  if (!authMockAllowed()) return null;
  const raw = process.env.AUTH_MOCK_USER ?? '';
  const [id, email] = raw.split(':');
  if (!id) return null;
  return { id, email: email ?? null, emailVerified: true, name: 'Usuario de pruebas', picture: null };
}

/** Logged-in panel user (Kinde session), or null. */
export async function getAuthUser(): Promise<AuthUser | null> {
  const mock = getMockUser();
  if (mock) return mock;
  const { isAuthenticated, getUser, getIdToken } = getKindeServerSession();
  if (!(await isAuthenticated())) return null;
  const user = await getUser();
  if (!user?.id) return null;
  const name = [user.given_name, user.family_name].filter(Boolean).join(' ').trim();
  // Without a readable ID token the email is treated as unverified (fails closed).
  let idToken: { email_verified?: boolean } | null = null;
  try {
    idToken = await getIdToken();
  } catch {
    idToken = null;
  }
  return {
    id: user.id,
    email: user.email ?? null,
    emailVerified: idToken?.email_verified === true,
    name: name || null,
    picture: user.picture ?? null,
  };
}
