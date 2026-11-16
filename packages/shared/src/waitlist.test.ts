import { describe, expect, it } from 'vitest';
import type { BusyAppointment } from './availability';
import { zonedTimeToUtc } from './dates';
import { exactTimeWindow, findWaitlistSlot, wholeDayWindow } from './waitlist';

const TZ = 'Europe/Madrid';
// 2031-01-06 is a Monday.
const at = (d: number, h: number, mi = 0, month = 1) => zonedTimeToUtc({ year: 2031, month, day: d, hour: h, minute: mi }, TZ);
const ana = { id: 'ana', active: true, schedule: [{ day: 'monday' as const, start: '09:00', end: '12:00' }] };
const busy = (h: number, employeeId = 'ana'): BusyAppointment => ({ employeeId, date: at(6, h), durationMinutes: 60, status: 'pending' });
const base = { employees: [ana], durationMinutes: 60, slotMinutes: 60, timeZone: TZ, earliest: at(5, 12) };

describe('waiting list windows', () => {
  it('covers the whole local day, also on DST days', () => {
    expect(wholeDayWindow(at(6, 10), TZ)).toEqual({ start: at(6, 0), end: at(6, 23, 59), wholeDay: true, preferred: at(6, 10) });
    // 2031-03-30: clocks go forward at 02:00 in Madrid (a 23-hour day).
    const dst = wholeDayWindow(at(30, 12, 0, 3), TZ);
    expect(dst.end.getTime() - dst.start.getTime()).toBe((23 * 60 - 1) * 60_000);
    expect(exactTimeWindow(at(6, 10))).toEqual({ start: at(6, 10), end: at(6, 10), wholeDay: false, preferred: at(6, 10) });
  });
});

describe('findWaitlistSlot', () => {
  it('finds the free slot of the day closest to the requested time for whole-day entries', () => {
    const window = wholeDayWindow(at(6, 9), TZ);
    expect(findWaitlistSlot({ ...base, busy: [busy(9), busy(10), busy(11)], window })).toBeNull();
    expect(findWaitlistSlot({ ...base, busy: [busy(9), busy(11)], window })).toEqual({ start: at(6, 10), employeeId: 'ana' });
    expect(findWaitlistSlot({ ...base, busy: [], window: wholeDayWindow(at(6, 11), TZ) })?.start).toEqual(at(6, 11));
    // 10:00 asked; 9:00 and 11:00 are equally close: the earlier one.
    expect(findWaitlistSlot({ ...base, busy: [busy(10)], window: wholeDayWindow(at(6, 10), TZ) })?.start).toEqual(at(6, 9));
  });

  it('only offers the requested time to exact-time entries', () => {
    const window = exactTimeWindow(at(6, 9));
    expect(findWaitlistSlot({ ...base, busy: [busy(9)], window })).toBeNull();
    expect(findWaitlistSlot({ ...base, busy: [busy(10)], window })).toEqual({ start: at(6, 9), employeeId: 'ana' });
  });

  it('respects the minimum notice and never repeats an offered start', () => {
    const window = wholeDayWindow(at(6, 9), TZ);
    expect(findWaitlistSlot({ ...base, busy: [], window, earliest: at(6, 9, 30) })?.start).toEqual(at(6, 10));
    expect(findWaitlistSlot({ ...base, busy: [], window, exclude: [at(6, 9), at(6, 10)] })?.start).toEqual(at(6, 11));
    expect(findWaitlistSlot({ ...base, busy: [], window: exactTimeWindow(at(6, 9)), earliest: at(6, 9, 30) })).toBeNull();
  });
});
