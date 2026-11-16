'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { MemberRoleValue } from '@clinicai/shared';

export interface TenantInfo {
  id: string;
  clinicName: string;
  timezone: string;
  slotMinutes: number;
  /** F18: role of the logged-in user; a professional only sees their own employee. */
  role: MemberRoleValue;
  employeeId: string | null;
  employeeName: string | null;
}

const TenantContext = createContext<TenantInfo | null>(null);

export function TenantProvider({ tenant, children }: { tenant: TenantInfo; children: ReactNode }) {
  return <TenantContext.Provider value={tenant}>{children}</TenantContext.Provider>;
}

/** Tenant of the logged-in user (time zone used to show and interpret dates) and their role. */
export function useTenant(): TenantInfo {
  const tenant = useContext(TenantContext);
  if (!tenant) throw new Error('useTenant must be used inside <TenantProvider>');
  return tenant;
}
