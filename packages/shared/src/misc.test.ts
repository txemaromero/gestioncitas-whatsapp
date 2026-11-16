import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { employeeColor } from './colors';
import { decryptSecret, encryptSecret, maskSecret } from './crypto';
import { buildDefaultFaqPrompt } from './faq-template';
import { maskEmail, maskPhone, normalizePhone, waIdToE164 } from './phone';
import { formatScheduleEs, scheduleSchema, validateSchedule } from './schedule';
import { parseTenantSettings } from './settings';
import { isValidEmail, isValidFullName, normalizeText } from './text';

describe('phone', () => {
  it('normalizes Spanish numbers to E.164', () => {
    expect(normalizePhone('600 123 456')).toBe('+34600123456');
    expect(normalizePhone('+34 600-12-34-56')).toBe('+34600123456');
    expect(normalizePhone('0034600123456')).toBe('+34600123456');
    expect(normalizePhone('12')).toBeNull();
  });

  it('converts WhatsApp wa_id to E.164', () => {
    expect(waIdToE164('34600123456')).toBe('+34600123456');
  });

  it('masks PII for logs', () => {
    expect(maskPhone('+34600123456')).toBe('+34*****3456');
    expect(maskEmail('nombre@gmail.com')).toBe('n*****@gmail.com');
  });
});

describe('text validation', () => {
  it('validates emails', () => {
    expect(isValidEmail('nombre@gmail.com')).toBe(true);
    expect(isValidEmail('nombre@gmail')).toBe(false);
    expect(isValidEmail('no es un email')).toBe(false);
  });

  it('validates full names (2-80 chars, at least one letter)', () => {
    expect(isValidFullName('Ana López')).toBe(true);
    expect(isValidFullName('A')).toBe(false);
    expect(isValidFullName('12345')).toBe(false);
    expect(isValidFullName('x'.repeat(81))).toBe(false);
  });

  it('normalizes accents and case', () => {
    expect(normalizeText('  Inés  ¡Menú! ')).toBe('ines menu');
  });
});

describe('schedule', () => {
  it('rejects start >= end and overlapping ranges on the same day', () => {
    expect(validateSchedule([{ day: 'monday', start: '10:00', end: '09:00' }])).toHaveLength(1);
    expect(
      validateSchedule([
        { day: 'monday', start: '09:00', end: '12:00' },
        { day: 'monday', start: '11:00', end: '13:00' },
      ]),
    ).toHaveLength(1);
    expect(
      scheduleSchema.safeParse([
        { day: 'monday', start: '09:00', end: '12:00' },
        { day: 'monday', start: '12:00', end: '13:00' },
      ]).success,
    ).toBe(true);
  });

  it('formats a schedule in Spanish (Monday first)', () => {
    expect(
      formatScheduleEs([
        { day: 'wednesday', start: '07:00', end: '19:55' },
        { day: 'monday', start: '07:00', end: '13:55' },
      ]),
    ).toBe('Lunes: 07:00 - 13:55, Miércoles: 07:00 - 19:55');
    expect(formatScheduleEs([])).toBe('-');
  });
});

describe('settings', () => {
  it('fills defaults', () => {
    expect(parseTenantSettings({})).toMatchObject({
      faqPrompt: null,
      slotMinutes: 60,
      reminderHour: '08:00',
      contactPhone: '',
    });
  });

  it('drops invalid keys instead of failing', () => {
    expect(parseTenantSettings({ slotMinutes: 'x', contactPhone: '600' })).toMatchObject({
      slotMinutes: 60,
      contactPhone: '600',
    });
  });

  it('privacy settings (F12): http(s) policy URL only, retention disabled by default and bounded', () => {
    expect(parseTenantSettings({})).toMatchObject({ privacyPolicyUrl: null, retentionMonths: null });
    expect(parseTenantSettings({ privacyPolicyUrl: 'https://clinica.es/privacidad', retentionMonths: 24 })).toMatchObject({
      privacyPolicyUrl: 'https://clinica.es/privacidad',
      retentionMonths: 24,
    });
    expect(parseTenantSettings({ privacyPolicyUrl: 'javascript:alert(1)' }).privacyPolicyUrl).toBeNull();
    expect(parseTenantSettings({ privacyPolicyUrl: 'ftp://clinica.es/p' }).privacyPolicyUrl).toBeNull();
    expect(parseTenantSettings({ retentionMonths: 1 }).retentionMonths).toBeNull();
    expect(parseTenantSettings({ retentionMonths: 600 }).retentionMonths).toBeNull();
  });
});

describe('crypto', () => {
  const key = randomBytes(32).toString('base64');

  it('encrypts and decrypts with AES-256-GCM', () => {
    const enc = encryptSecret('EAAG-token-123', key);
    expect(enc.startsWith('v1.')).toBe(true);
    expect(enc).not.toContain('EAAG');
    expect(decryptSecret(enc, key)).toBe('EAAG-token-123');
  });

  it('fails with a different key or tampered data', () => {
    const enc = encryptSecret('secret', key);
    expect(() => decryptSecret(enc, randomBytes(32).toString('base64'))).toThrow();
    expect(() => encryptSecret('x', 'short')).toThrow(/32 bytes/);
    expect(maskSecret('EAAGabcdefgh1234')).toBe('EAAG••••••1234');
  });
});

describe('default FAQ prompt', () => {
  it('fills tenant data and uses the fallback for unknown data', () => {
    const prompt = buildDefaultFaqPrompt({
      clinicName: 'Fisio Sur',
      phone: '965 000 000',
      employees: [
        { name: 'Lucía', role: 'fisioterapeuta', active: true, schedule: [{ day: 'monday', start: '09:00', end: '14:00' }] },
        { name: 'Admin', role: 'admin', active: true, schedule: [] },
      ],
    });
    expect(prompt).toContain('recepcionista virtual de Fisio Sur, una clínica de fisioterapia');
    expect(prompt).toContain('- Lucía: fisioterapeuta');
    expect(prompt).not.toContain('Admin');
    expect(prompt).toContain('Horario: lunes de 09:00 a 14:00');
    expect(prompt).toContain('Dirección: Consultar por teléfono');
    expect(prompt).toContain('Llama al 965 000 000');
    expect(prompt).not.toMatch(/\{\w+\}/);
  });
});

describe('employee colors', () => {
  it('is stable per id', () => {
    expect(employeeColor('abc')).toBe(employeeColor('abc'));
    expect(employeeColor('abc')).toMatch(/^#[0-9a-f]{6}$/);
  });
});
