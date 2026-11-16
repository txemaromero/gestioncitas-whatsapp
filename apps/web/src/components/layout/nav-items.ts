import { BarChart3Icon, CalendarDaysIcon, LayoutDashboardIcon, UserRoundIcon, UsersIcon, type LucideIcon } from 'lucide-react';
import { isAdminRole, type MemberRoleValue } from '@clinicai/shared';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Only for the owner and administrators (F18). */
  adminOnly?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { href: '/dashboard', label: 'Inicio', icon: LayoutDashboardIcon },
  { href: '/calendar', label: 'Calendario', icon: CalendarDaysIcon },
  { href: '/employees', label: 'Empleados', icon: UsersIcon, adminOnly: true },
  { href: '/clients', label: 'Clientes', icon: UserRoundIcon, adminOnly: true },
  { href: '/metrics', label: 'Métricas', icon: BarChart3Icon, adminOnly: true },
];

/** Sections a user can open (the pages check it again on the server). */
export function navItemsFor(role: MemberRoleValue): NavItem[] {
  return isAdminRole(role) ? NAV_ITEMS : NAV_ITEMS.filter((item) => !item.adminOnly);
}
