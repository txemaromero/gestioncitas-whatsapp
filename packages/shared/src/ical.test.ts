import { describe, expect, it } from 'vitest';
import { buildIcal, clientInitials, foldIcalLine, icalText, icalUtc } from './ical';

const encoder = new TextEncoder();

describe('iCalendar of the agenda (F28)', () => {
  it('escapes texts and writes UTC times', () => {
    expect(icalText('Cita; con Ana, en\nFisio\\Demo')).toBe('Cita\\; con Ana\\, en\\nFisio\\\\Demo');
    // F34: a lone CR or a control character cannot start a new property.
    expect(icalText('X\rEND:VEVENT\r\nBEGIN:VEVENT\u0000\u2028SUMMARY:Pwned')).toBe('X\\nEND:VEVENT\\nBEGIN:VEVENTSUMMARY:Pwned');
    expect(icalUtc(new Date('2026-11-18T09:05:07Z'))).toBe('20261118T090507Z');
  });

  it('folds long lines at 75 octets without splitting characters', () => {
    const line = `SUMMARY:${'Sesión de fisioterapia con ñandúes y acentos '.repeat(4)}`;
    const folded = foldIcalLine(line);
    const parts = folded.split('\r\n');
    expect(parts.length).toBeGreaterThan(2);
    expect(encoder.encode(parts[0]).length).toBeLessThanOrEqual(75);
    for (const part of parts.slice(1)) {
      expect(part.startsWith(' ')).toBe(true);
      expect(encoder.encode(part).length).toBeLessThanOrEqual(75);
    }
    // Unfolding gives the original line back.
    expect(folded.replace(/\r\n /g, '')).toBe(line);
    expect(foldIcalLine('SUMMARY:corto')).toBe('SUMMARY:corto');
  });

  it('builds a calendar with timed and whole-day events', () => {
    const ics = buildIcal({
      name: 'Ana · FisioDemo',
      timeZone: 'Europe/Madrid',
      now: new Date('2026-11-13T10:00:00Z'),
      events: [
        {
          uid: 'a1@clinicai',
          summary: 'L. M. · Sesión de fisioterapia',
          description: 'Cita en FisioDemo. Estado: confirmada.',
          start: new Date('2026-11-18T09:00:00Z'),
          end: new Date('2026-11-18T10:00:00Z'),
          status: 'CONFIRMED',
        },
        {
          uid: 't1@clinicai',
          summary: 'Clínica cerrada: Festivo',
          start: new Date('2026-12-07T23:00:00Z'),
          end: new Date('2026-12-08T23:00:00Z'),
          allDay: { startKey: '2026-12-08', endKey: '2026-12-09' },
        },
      ],
    });
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics.split('\r\n').slice(0, 6)).toEqual(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ClinicAI//Agenda//ES', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Ana · FisioDemo']);
    expect(ics).toContain('BEGIN:VEVENT\r\nUID:a1@clinicai\r\nDTSTAMP:20261113T100000Z\r\nDTSTART:20261118T090000Z\r\nDTEND:20261118T100000Z\r\n');
    expect(ics).toContain('SUMMARY:L. M. · Sesión de fisioterapia\r\nDESCRIPTION:Cita en FisioDemo. Estado: confirmada.\r\nSTATUS:CONFIRMED\r\nEND:VEVENT');
    expect(ics).toContain('DTSTART;VALUE=DATE:20261208\r\nDTEND;VALUE=DATE:20261209\r\nSUMMARY:Clínica cerrada: Festivo\r\nEND:VEVENT');
    // No bare LF anywhere.
    expect(ics.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('shows clients by their initials', () => {
    expect(clientInitials('Laura Martínez Pérez')).toBe('L. M.');
    expect(clientInitials('  ñandú  ')).toBe('Ñ.');
    expect(clientInitials('Óscar de la Fuente')).toBe('Ó. D.');
    expect(clientInitials('')).toBe('Cliente');
  });
});
