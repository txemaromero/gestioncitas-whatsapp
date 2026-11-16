/**
 * F27: public booking page of a clinic (`/reservar/<slug>`). It shows the free slots; choosing one
 * opens WhatsApp with a message that carries a reference with the service and the local date and
 * time, which the bot reads with rules (no LLM) to go straight to that slot.
 */
import { z } from 'zod';
import { formatHumanDate, formatTime, getZonedParts, pad2, zonedTimeToUtc } from './dates';
import { normalizeText } from './text';

/** Days shown, today included. */
export const BOOKING_PAGE_DAYS = 14;
/** Slots starting sooner than this are not offered (time to write and confirm by WhatsApp). */
export const BOOKING_PAGE_LEAD_MINUTES = 60;

export const PUBLIC_SLUG_MAX = 40;
export const publicSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Mínimo 3 caracteres')
  .max(PUBLIC_SLUG_MAX, `Máximo ${PUBLIC_SLUG_MAX} caracteres`)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Solo letras sin tildes, números y guiones (sin guion al principio ni al final)');

/** «Fisio Ñandú Salud» → «fisio-nandu-salud» (a suggestion; the clinic can change it). */
export function slugify(text: string): string {
  return normalizeText(text)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, PUBLIC_SLUG_MAX)
    .replace(/-+$/, '');
}

export interface WebBookingRef {
  /** `W-261118-1000-3f2a9c1d` as it travels in the message. */
  code: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** `serviceRefCode` of the service; null = no service. */
  serviceCode: string | null;
}

const NO_SERVICE = '00000000';
const REF_PATTERN = /\bW-(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})-([0-9a-f]{8})\b/i;

/**
 * 8 hex digits of the whole service id (FNV-1a), so ids with a common beginning still differ.
 * The bot only accepts a code that matches exactly one service of the clinic.
 */
export function serviceRefCode(serviceId: string): string {
  let hash = 0x811c9dc5;
  for (const char of serviceId.toLowerCase()) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Reference of a slot: its local date and time in the clinic zone and the service. */
export function webBookingRef(start: Date, serviceId: string | null, timeZone: string): string {
  const p = getZonedParts(start, timeZone);
  const service = serviceId ? serviceRefCode(serviceId) : NO_SERVICE;
  return `W-${String(p.year % 100).padStart(2, '0')}${pad2(p.month)}${pad2(p.day)}-${pad2(p.hour)}${pad2(p.minute)}-${service}`;
}

/** The reference in a message (anywhere in the text), or null. */
export function readWebBookingRef(text: string): WebBookingRef | null {
  const m = REF_PATTERN.exec(text);
  if (!m) return null;
  const [year, month, day, hour, minute] = [2000 + Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const service = (m[6] ?? '').toLowerCase();
  const code = `W-${m[1]}${m[2]}${m[3]}-${m[4]}${m[5]}-${service}`;
  return { code, year, month, day, hour, minute, serviceCode: service === NO_SERVICE ? null : service };
}

/** UTC instant of the slot of a reference. */
export function webBookingStart(ref: WebBookingRef, timeZone: string): Date {
  return zonedTimeToUtc({ year: ref.year, month: ref.month, day: ref.day, hour: ref.hour, minute: ref.minute }, timeZone);
}

/** «Hola, quiero pedir cita para Fisioterapia el miércoles, 18 de noviembre de 2026 a las 10:00 (ref. W-…).» */
export function webBookingMessage(input: { serviceName: string | null; start: Date; timeZone: string; serviceId: string | null }): string {
  const { serviceName, start, timeZone, serviceId } = input;
  const ref = webBookingRef(start, serviceId, timeZone);
  return `Hola, quiero pedir cita${serviceName ? ` para ${serviceName}` : ''} el ${formatHumanDate(start, timeZone)} a las ${formatTime(start, timeZone)} (ref. ${ref}).`;
}

/** Link that opens a WhatsApp chat with the clinic and the message already written. */
export function whatsappLink(phoneE164: string, message: string): string {
  return `https://wa.me/${phoneE164.replace(/\D/g, '')}?text=${encodeURIComponent(message)}`;
}
