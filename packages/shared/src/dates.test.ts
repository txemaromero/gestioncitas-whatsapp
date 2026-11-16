import { describe, expect, it } from 'vitest';
import {
  addZonedDays,
  formatHumanDateTime,
  formatShortSlot,
  fromDateTimeLocalValue,
  getZonedParts,
  getZonedWeekday,
  roundToSlot,
  toDateTimeLocalValue,
  toZonedIso,
  zonedDayRange,
  zonedTimeToUtc,
} from './dates';

const TZ = 'Europe/Madrid';

describe('zonedTimeToUtc', () => {
  it('converts Madrid summer time (UTC+2)', () => {
    expect(zonedTimeToUtc({ year: 2025, month: 5, day: 8, hour: 12, minute: 0 }, TZ).toISOString()).toBe(
      '2025-05-08T10:00:00.000Z',
    );
  });

  it('converts Madrid winter time (UTC+1)', () => {
    expect(zonedTimeToUtc({ year: 2025, month: 1, day: 15, hour: 9, minute: 30 }, TZ).toISOString()).toBe(
      '2025-01-15T08:30:00.000Z',
    );
  });

  it('handles the spring-forward day (30 Mar 2025)', () => {
    expect(zonedTimeToUtc({ year: 2025, month: 3, day: 30, hour: 1 }, TZ).toISOString()).toBe(
      '2025-03-30T00:00:00.000Z',
    );
    expect(zonedTimeToUtc({ year: 2025, month: 3, day: 30, hour: 10 }, TZ).toISOString()).toBe(
      '2025-03-30T08:00:00.000Z',
    );
  });

  it('handles the fall-back day (26 Oct 2025)', () => {
    expect(zonedTimeToUtc({ year: 2025, month: 10, day: 26, hour: 10 }, TZ).toISOString()).toBe(
      '2025-10-26T09:00:00.000Z',
    );
  });
});

describe('formatting', () => {
  it('formats the human Spanish date used by the bot', () => {
    const date = new Date('2025-05-08T10:00:00Z');
    expect(formatHumanDateTime(date, TZ)).toBe('jueves, 8 de mayo de 2025, 12:00');
  });

  it('builds a short slot label that fits a WhatsApp button (≤ 20 chars)', () => {
    const label = formatShortSlot(new Date('2025-05-08T10:00:00Z'), TZ);
    expect(label).toBe('jue 8 may, 12:00');
    expect(label.length).toBeLessThanOrEqual(20);
  });

  it('prints ISO with offset', () => {
    expect(toZonedIso(new Date('2025-05-08T10:00:00Z'), TZ)).toBe('2025-05-08T12:00:00+02:00');
    expect(toZonedIso(new Date('2025-01-08T10:00:00Z'), TZ)).toBe('2025-01-08T11:00:00+01:00');
  });

  it('round-trips datetime-local values in the tenant zone', () => {
    const date = fromDateTimeLocalValue('2025-06-04T12:00', TZ);
    expect(date?.toISOString()).toBe('2025-06-04T10:00:00.000Z');
    expect(toDateTimeLocalValue(date!, TZ)).toBe('2025-06-04T12:00');
    expect(fromDateTimeLocalValue('04/06/2025', TZ)).toBeNull();
  });
});

describe('calendar arithmetic', () => {
  it('adds days keeping wall-clock time across DST', () => {
    const before = zonedTimeToUtc({ year: 2025, month: 3, day: 29, hour: 10 }, TZ);
    const after = addZonedDays(before, 1, TZ);
    expect(getZonedParts(after, TZ)).toMatchObject({ day: 30, hour: 10 });
    expect(after.getTime() - before.getTime()).toBe(23 * 3600 * 1000);
  });

  it('computes tomorrow range in the tenant zone', () => {
    const now = new Date('2025-05-07T22:30:00Z'); // 00:30 on 8 May in Madrid
    const { start, end } = zonedDayRange(now, 1, TZ);
    expect(start.toISOString()).toBe('2025-05-08T22:00:00.000Z');
    expect(end.toISOString()).toBe('2025-05-09T22:00:00.000Z');
  });

  it('returns weekday in the zone, not in UTC', () => {
    // 23:30 UTC Sunday = 01:30 Monday in Madrid (summer)
    expect(getZonedWeekday(new Date('2025-05-11T23:30:00Z'), TZ)).toBe('monday');
  });

  it('rounds to the slot grid', () => {
    const t = zonedTimeToUtc({ year: 2025, month: 5, day: 8, hour: 10, minute: 20 }, TZ);
    expect(getZonedParts(roundToSlot(t, 60, TZ), TZ)).toMatchObject({ hour: 10, minute: 0 });
    const t2 = zonedTimeToUtc({ year: 2025, month: 5, day: 8, hour: 10, minute: 40 }, TZ);
    expect(getZonedParts(roundToSlot(t2, 60, TZ), TZ)).toMatchObject({ hour: 11, minute: 0 });
    expect(getZonedParts(roundToSlot(t2, 30, TZ), TZ)).toMatchObject({ hour: 10, minute: 30 });
  });
});
