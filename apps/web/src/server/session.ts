import 'server-only';
import { createRepos, findOrClaimMember, getDatabase } from '@clinicai/db';
import { isAdminRole } from '@clinicai/shared';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { getAuthUser } from './auth';
import { verifiedEmail } from './identity';
import { isPlatformAdmin } from './platform';

/** Session for server components: user + tenant membership (cached per request). */
export const getSession = cache(async () => {
  const user = await getAuthUser();
  if (!user) return { user: null, member: null, tenant: null } as const;
  // Membership and clinic of the user, before any clinic context: owner connection (F19).
  const { system } = getDatabase();
  const repos = createRepos(system);
  // F18: a user invited by a clinic joins it on their first visit.
  const member = await findOrClaimMember(system, user.id, verifiedEmail(user));
  const tenant = member ? await repos.tenants.findById(member.tenantId) : null;
  return { user, member, tenant } as const;
});

/** Requires a logged-in user that already belongs to a tenant (otherwise → / or /onboarding). */
export async function requireTenantSession() {
  const session = await getSession();
  if (!session.user) redirect('/');
  if (!session.member || !session.tenant) redirect('/onboarding');
  return { user: session.user, member: session.member, tenant: session.tenant };
}

/** Pages for the owner and administrators only (F18): professionals go back to Inicio. */
export async function requireAdminSession() {
  const session = await requireTenantSession();
  if (!isAdminRole(session.member.role)) redirect('/dashboard');
  return session;
}

/** F31: the signed-in user when they are a platform administrator (PLATFORM_ADMIN_EMAILS), otherwise null. */
export const getPlatformAdmin = cache(async () => {
  const user = await getAuthUser();
  return user && isPlatformAdmin(verifiedEmail(user)) ? user : null;
});
