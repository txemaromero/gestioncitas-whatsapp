import type { ReactNode } from 'react';
import { AppHeader } from '@/components/layout/app-header';
import { TenantProvider } from '@/components/layout/tenant-context';
import { MobileNav } from '@/components/mobile/mobile-nav';
import { createRepos, getDatabase, runWithTenant } from '@clinicai/db';
import { verifiedEmail } from '@/server/identity';
import { isPlatformAdmin } from '@/server/platform';
import { requireTenantSession } from '@/server/session';

export const dynamic = 'force-dynamic';

/** Authenticated area: requires a Kinde session and a clinic (otherwise → / or /onboarding). */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const { user, member, tenant } = await requireTenantSession();
  const employeeId = member.employeeId;
  const employee = employeeId
    ? await runWithTenant(tenant.id, () => createRepos(getDatabase().app).employees.findById(tenant.id, employeeId))
    : null;
  return (
    <TenantProvider
      tenant={{
        id: tenant.id,
        clinicName: tenant.clinicName,
        timezone: tenant.timezone,
        slotMinutes: tenant.settings.slotMinutes,
        role: member.role,
        employeeId: member.employeeId,
        employeeName: employee?.name ?? null,
      }}
    >
      <AppHeader
        clinicName={tenant.clinicName}
        user={{ name: user.name, email: user.email, picture: user.picture }}
        platformAdmin={isPlatformAdmin(verifiedEmail(user))}
      />
      <main className="mx-auto w-full max-w-7xl px-4 pt-6 pb-24 sm:px-6 md:pb-10">{children}</main>
      <MobileNav />
    </TenantProvider>
  );
}
