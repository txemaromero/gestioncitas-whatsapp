import { describe, expect, it } from 'vitest';
import { getZonedParts, zonedTimeToUtc } from './dates';
import { attendanceSpendsSession, defaultPackName, packFieldsSchema, packState } from './packs';
import { seriesCandidateLimit, seriesCandidates } from './series';

const TZ = 'Europe/Madrid';
const madrid = (year: number, month: number, day: number, hour = 10, minute = 0) => zonedTimeToUtc({ year, month, day, hour, minute }, TZ);
const local = (d: Date) => {
  const p = getZonedParts(d, TZ);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
};

describe('treatment dates (F26)', () => {
  it('follows the weekdays from the week of the first date, at its local time', () => {
    // Wednesday 4 November 2026: Monday of that week is already past, so it starts on Wednesday.
    const dates = seriesCandidates({ first: madrid(2026, 11, 4, 18, 30), weekdays: [1, 3], intervalWeeks: 1, timeZone: TZ }, 5);
    expect(dates.map(local)).toEqual(['2026-11-04 18:30', '2026-11-09 18:30', '2026-11-11 18:30', '2026-11-16 18:30', '2026-11-18 18:30']);
  });

  it('every two weeks, Sunday last, and the first date need not be one of the weekdays', () => {
    const dates = seriesCandidates({ first: madrid(2026, 11, 3), weekdays: [0, 5], intervalWeeks: 2, timeZone: TZ }, 4);
    expect(dates.map(local)).toEqual(['2026-11-06 10:00', '2026-11-08 10:00', '2026-11-20 10:00', '2026-11-22 10:00']);
  });

  it('keeps the local time across daylight saving changes', () => {
    // Tuesdays from 16 March 2027: summer time starts on Sunday 28 March.
    const dates = seriesCandidates({ first: madrid(2027, 3, 16, 9), weekdays: [2], intervalWeeks: 1, timeZone: TZ }, 3);
    expect(dates.map(local)).toEqual(['2027-03-16 09:00', '2027-03-23 09:00', '2027-03-30 09:00']);
    expect(dates[2]!.getTime() - dates[1]!.getTime()).toBe(7 * 86_400_000 - 3_600_000);
  });

  it('ignores invalid weekdays and limits what it looks at', () => {
    expect(seriesCandidates({ first: madrid(2026, 11, 3), weekdays: [], intervalWeeks: 1, timeZone: TZ }, 5)).toEqual([]);
    expect(seriesCandidates({ first: madrid(2026, 11, 3), weekdays: [9, 2, 2], intervalWeeks: 1, timeZone: TZ }, 2).map(local)).toEqual([
      '2026-11-03 10:00',
      '2026-11-10 10:00',
    ]);
    expect(seriesCandidateLimit(10, 2)).toBe(10 + 16);
  });
});

describe('session packs (F26)', () => {
  it('state, default name and what spends a session', () => {
    expect(packState({ totalSessions: 10, used: 3, expiresOn: null }, '2026-11-13')).toBe('active');
    expect(packState({ totalSessions: 10, used: 10, expiresOn: null }, '2026-11-13')).toBe('used_up');
    expect(packState({ totalSessions: 10, used: 3, expiresOn: '2026-11-13' }, '2026-11-13')).toBe('active');
    expect(packState({ totalSessions: 10, used: 3, expiresOn: '2026-11-12' }, '2026-11-13')).toBe('expired');
    expect(defaultPackName(10)).toBe('Bono 10 sesiones');
    expect(defaultPackName(1)).toBe('Bono 1 sesión');
    expect(attendanceSpendsSession('attended', false)).toBe(true);
    expect(attendanceSpendsSession('no_show', false)).toBe(false);
    expect(attendanceSpendsSession('no_show', true)).toBe(true);
    expect(attendanceSpendsSession(null, true)).toBe(false);
  });

  it('validates the fields of a pack', () => {
    expect(packFieldsSchema.safeParse({ name: ' Bono ', totalSessions: 10, serviceId: null, expiresOn: '2027-01-31' }).success).toBe(true);
    expect(packFieldsSchema.safeParse({ name: 'Bono', totalSessions: 0, serviceId: null, expiresOn: null }).success).toBe(false);
    expect(packFieldsSchema.safeParse({ name: 'Bono', totalSessions: 101, serviceId: null, expiresOn: null }).success).toBe(false);
    expect(packFieldsSchema.safeParse({ name: 'Bono', totalSessions: 5, serviceId: null, expiresOn: '31/01/2027' }).success).toBe(false);
  });
});
