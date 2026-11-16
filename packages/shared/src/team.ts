/**
 * Panel users of a clinic (F18). Owner and administrators manage everything; a professional is
 * linked to one employee and only sees and manages that employee's appointments.
 */
import { z } from 'zod';

export const MEMBER_ROLE_LABELS_ES = {
  owner: 'Propietario',
  admin: 'Administrador',
  professional: 'Profesional',
} as const;
export type MemberRoleValue = keyof typeof MEMBER_ROLE_LABELS_ES;

/** Roles that can be given by invitation (there is one owner: whoever created the clinic). */
export const INVITABLE_ROLES = ['admin', 'professional'] as const;

/**
 * F34: an invitation can be taken for 14 days; after that it only shows as expired and inviting the
 * same email again replaces it (a forgotten invitation to a mailbox that changes hands stops working).
 */
export const INVITATION_TTL_DAYS = 14;

export function invitationCutoff(now: Date): Date {
  return new Date(now.getTime() - INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export function invitationExpired(createdAt: Date, now: Date): boolean {
  return createdAt.getTime() < invitationCutoff(now).getTime();
}
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

export function isAdminRole(role: MemberRoleValue): boolean {
  return role === 'owner' || role === 'admin';
}

/** Emails are compared in lower case (Kinde sends the one the person signs in with). */
export const memberEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: 'Email no válido' }).max(254));

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
