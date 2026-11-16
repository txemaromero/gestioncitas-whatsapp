/**
 * F26: session packs (bonos). A session is spent when an appointment of the client is marked as
 * attended, or as a no-show if the clinic says so (`settings.packNoShowSpends`).
 */
import { z } from 'zod';

export const PACK_MAX_SESSIONS = 100;
export const PACK_NAME_MAX = 60;

/** «Bono 10 sesiones» / «Bono 1 sesión». */
export function defaultPackName(sessions: number): string {
  return `Bono ${sessions} ${sessions === 1 ? 'sesión' : 'sesiones'}`;
}

export type PackState = 'active' | 'used_up' | 'expired';

export const PACK_STATE_LABELS_ES: Record<PackState, string> = {
  active: 'Vigente',
  used_up: 'Agotado',
  expired: 'Caducado',
};

/** `todayKey` and `expiresOn` are local dates `YYYY-MM-DD` of the clinic (valid through that day). */
export function packState(pack: { totalSessions: number; used: number; expiresOn: string | null }, todayKey: string): PackState {
  if (pack.used >= pack.totalSessions) return 'used_up';
  if (pack.expiresOn !== null && pack.expiresOn < todayKey) return 'expired';
  return 'active';
}

/** Does an appointment with this attendance spend a session of a pack? */
export function attendanceSpendsSession(attendance: 'attended' | 'no_show' | null, noShowSpends: boolean): boolean {
  return attendance === 'attended' || (attendance === 'no_show' && noShowSpends);
}

const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha no válida');

/** Fields of a pack in the panel (the client comes apart). */
export const packFieldsSchema = z.object({
  name: z.string().trim().min(2, 'Escribe un nombre').max(PACK_NAME_MAX),
  totalSessions: z.number().int().min(1, 'Al menos 1 sesión').max(PACK_MAX_SESSIONS, `Como máximo ${PACK_MAX_SESSIONS}`),
  /** Only for this service; null = any. */
  serviceId: z.uuid().nullable(),
  /** Last day it can be used; null = no expiry. */
  expiresOn: dateKey.nullable(),
});
export type PackFields = z.infer<typeof packFieldsSchema>;
