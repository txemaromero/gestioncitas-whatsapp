import { describe, expect, it } from 'vitest';
import {
  publicSlugSchema,
  readWebBookingRef,
  serviceRefCode,
  slugify,
  webBookingMessage,
  webBookingRef,
  webBookingStart,
  whatsappLink,
} from './booking-page';
import { zonedTimeToUtc } from './dates';

const TZ = 'Europe/Madrid';
const SERVICE = '3f2a9c1d-7b4e-4c8a-9d10-123456789abc';

describe('public booking page (F27)', () => {
  it('suggests and validates the address of the page', () => {
    expect(slugify('Fisio Ñandú  Salud, S.L.')).toBe('fisio-nandu-salud-s-l');
    expect(slugify('  --Clínica   Norte--  ')).toBe('clinica-norte');
    expect(publicSlugSchema.parse(' FisioDemo ')).toBe('fisiodemo');
    for (const bad of ['ab', '-fisio', 'fisio-', 'fisio demo', 'físio', 'a'.repeat(41)]) {
      expect(publicSlugSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('the reference of a slot goes and comes back, in the clinic zone', () => {
    const start = zonedTimeToUtc({ year: 2026, month: 11, day: 18, hour: 10, minute: 0 }, TZ);
    const ref = webBookingRef(start, SERVICE, TZ);
    const code = serviceRefCode(SERVICE);
    expect(code).toMatch(/^[0-9a-f]{8}$/);
    expect(ref).toBe(`W-261118-1000-${code}`);
    const read = readWebBookingRef(`Hola, quiero pedir cita (ref. ${ref}).`)!;
    expect(read).toEqual({ code: ref, year: 2026, month: 11, day: 18, hour: 10, minute: 0, serviceCode: code });
    expect(webBookingStart(read, TZ)).toEqual(start);
    // Ids with the same beginning (like the demo ones) get different codes.
    const demo = ['11111111-0000-4000-a000-000000000001', '11111111-0000-4000-a000-000000000002', '11111111-0000-4000-a000-000000000003'];
    expect(new Set(demo.map(serviceRefCode)).size).toBe(3);
    expect(serviceRefCode(SERVICE.toUpperCase())).toBe(code);
    // Without a service; summer time; another zone.
    const july = zonedTimeToUtc({ year: 2027, month: 7, day: 5, hour: 9, minute: 30 }, 'Atlantic/Canary');
    const noService = readWebBookingRef(webBookingRef(july, null, 'Atlantic/Canary'))!;
    expect(noService).toMatchObject({ code: 'W-270705-0930-00000000', serviceCode: null });
    expect(webBookingStart(noService, 'Atlantic/Canary')).toEqual(july);
  });

  it('ignores texts without a valid reference', () => {
    for (const text of ['quiero cita mañana', 'ref. W-261318-1000-3f2a9c1d', 'W-261118-2500-3f2a9c1d', 'W-261118-1000-xyzxyzxy', 'AW-261118-1000-3f2a9c1d', 'W-261118-1000-3f2a9c']) {
      expect(readWebBookingRef(text), text).toBeNull();
    }
    // Case does not matter (some keyboards capitalise).
    expect(readWebBookingRef('w-261118-1000-3F2A9C1D')?.serviceCode).toBe('3f2a9c1d');
  });

  it('builds the WhatsApp message and link', () => {
    const start = zonedTimeToUtc({ year: 2026, month: 11, day: 18, hour: 10, minute: 0 }, TZ);
    const message = webBookingMessage({ serviceName: 'Fisioterapia', start, timeZone: TZ, serviceId: SERVICE });
    expect(message).toBe(
      `Hola, quiero pedir cita para Fisioterapia el miércoles, 18 de noviembre de 2026 a las 10:00 (ref. W-261118-1000-${serviceRefCode(SERVICE)}).`,
    );
    expect(webBookingMessage({ serviceName: null, start, timeZone: TZ, serviceId: null })).toBe(
      'Hola, quiero pedir cita el miércoles, 18 de noviembre de 2026 a las 10:00 (ref. W-261118-1000-00000000).',
    );
    const link = whatsappLink('+34 965 000 000', message);
    expect(link.startsWith('https://wa.me/34965000000?text=Hola%2C%20quiero')).toBe(true);
    expect(decodeURIComponent(link.split('?text=')[1]!)).toBe(message);
  });
});
