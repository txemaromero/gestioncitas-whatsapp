import { describe, expect, it } from 'vitest';
import {
  filterAvailableEmployees,
  findBlock,
  scheduledMinutes,
  findFreeSlots,
  hasConflict,
  isWithinSchedule,
  type AvailabilityEmployee,
  type BusyAppointment,
  type TimeBlock,
} from './availability';
import { formatShortSlot, isWholeLocalDays, localDaysRange, zonedTimeToUtc } from './dates';
import { formatDuration } from './services';
import type { ScheduleSlot } from './schedule';

const TZ = 'Europe/Madrid';
const at = (y: number, m: number, d: number, h: number, mi = 0): Date =>
  zonedTimeToUtc({ year: y, month: m, day: d, hour: h, minute: mi }, TZ);

// 2025-05-05 is a Monday.
const daniel: AvailabilityEmployee & { name: string } = {
  id: 'jc',
  name: 'Daniel',
  active: true,
  schedule: [
    { day: 'monday', start: '07:00', end: '13:55' },
    { day: 'wednesday', start: '07:00', end: '19:55' },
  ],
};
const marcos: AvailabilityEmployee & { name: string } = {
  id: 'ro',
  name: 'Marcos',
  active: true,
  schedule: [
    { day: 'monday', start: '12:00', end: '19:55' },
    // Two ranges on the same day.
    { day: 'saturday', start: '09:00', end: '11:00' },
    { day: 'saturday', start: '15:00', end: '17:00' },
  ],
};
const oscar: AvailabilityEmployee & { name: string } = { id: 'fa', name: 'Óscar', active: true, schedule: [] };

describe('isWithinSchedule', () => {
  it('accepts an interval fully inside a range', () => {
    expect(isWithinSchedule(daniel.schedule, at(2025, 5, 5, 12), 60, TZ)).toBe(true);
  });

  it('checks the whole interval [start, start + duration]', () => {
    expect(isWithinSchedule(daniel.schedule, at(2025, 5, 5, 11), 60, TZ)).toBe(true);
    expect(isWithinSchedule(daniel.schedule, at(2025, 5, 5, 12, 55), 60, TZ)).toBe(true);
    expect(isWithinSchedule(daniel.schedule, at(2025, 5, 5, 13), 60, TZ)).toBe(false);
    expect(isWithinSchedule(daniel.schedule, at(2025, 5, 5, 6, 30), 60, TZ)).toBe(false);
  });

  it('supports several ranges on the same day', () => {
    expect(isWithinSchedule(marcos.schedule, at(2025, 5, 10, 10), 60, TZ)).toBe(true);
    expect(isWithinSchedule(marcos.schedule, at(2025, 5, 10, 12), 60, TZ)).toBe(false);
    expect(isWithinSchedule(marcos.schedule, at(2025, 5, 10, 15), 60, TZ)).toBe(true);
  });

  it('returns false on a day without schedule', () => {
    expect(isWithinSchedule(daniel.schedule, at(2025, 5, 6, 10), 60, TZ)).toBe(false);
    expect(isWithinSchedule([], at(2025, 5, 5, 10), 60, TZ)).toBe(false);
  });

  it('uses the tenant time zone to get the weekday (not UTC)', () => {
    // Monday 00:30 in Madrid is still Sunday in UTC.
    const schedule: ScheduleSlot[] = [{ day: 'monday', start: '00:00', end: '02:00' }];
    expect(isWithinSchedule(schedule, at(2025, 5, 5, 0, 30), 60, TZ)).toBe(true);
  });

  it('is correct on DST days (spring forward and fall back)', () => {
    const schedule: ScheduleSlot[] = [{ day: 'sunday', start: '09:00', end: '17:00' }];
    expect(isWithinSchedule(schedule, at(2025, 3, 30, 9), 60, TZ)).toBe(true);
    expect(isWithinSchedule(schedule, at(2025, 3, 30, 16, 30), 60, TZ)).toBe(false);
    expect(isWithinSchedule(schedule, at(2025, 10, 26, 16), 60, TZ)).toBe(true);
    expect(isWithinSchedule(schedule, at(2025, 10, 26, 8, 30), 60, TZ)).toBe(false);
  });
});

describe('conflicts and filtering', () => {
  const busy: BusyAppointment[] = [
    { id: 'a1', employeeId: 'jc', date: at(2025, 5, 5, 10), durationMinutes: 60, status: 'pending' },
    { id: 'a2', employeeId: 'ro', date: at(2025, 5, 5, 12), durationMinutes: 60, status: 'cancelled' },
  ];

  it('detects overlaps (half-open intervals)', () => {
    expect(hasConflict('jc', at(2025, 5, 5, 10, 30), 60, busy)).toBe(true);
    expect(hasConflict('jc', at(2025, 5, 5, 9), 60, busy)).toBe(false); // ends exactly at 10:00
    expect(hasConflict('jc', at(2025, 5, 5, 11), 60, busy)).toBe(false); // starts exactly at 11:00
  });

  it('ignores cancelled appointments and the appointment being edited', () => {
    expect(hasConflict('ro', at(2025, 5, 5, 12), 60, busy)).toBe(false);
    expect(hasConflict('jc', at(2025, 5, 5, 10), 60, busy, 'a1')).toBe(false);
  });

  it('returns only active, scheduled and free employees', () => {
    const inactive = { ...marcos, id: 'ro2', active: false };
    const all = [daniel, marcos, oscar, inactive];
    expect(filterAvailableEmployees(all, busy, at(2025, 5, 5, 12), 60, TZ).map((e) => e.name)).toEqual([
      'Daniel',
      'Marcos',
    ]);
    expect(filterAvailableEmployees(all, busy, at(2025, 5, 5, 10), 60, TZ)).toEqual([]);
  });
});

describe('findFreeSlots', () => {
  it('suggests the nearest free slots on the grid', () => {
    const busy: BusyAppointment[] = [
      { employeeId: 'jc', date: at(2025, 5, 5, 12), durationMinutes: 60, status: 'pending' },
      { employeeId: 'ro', date: at(2025, 5, 5, 12), durationMinutes: 60, status: 'pending' },
    ];
    const slots = findFreeSlots({
      employees: [daniel, marcos],
      busy,
      from: at(2025, 5, 5, 12),
      durationMinutes: 60,
      slotMinutes: 60,
      timeZone: TZ,
    });
    expect(slots.map((s) => formatShortSlot(s, TZ))).toEqual([
      'lun 5 may, 13:00',
      'lun 5 may, 14:00',
      'lun 5 may, 15:00',
    ]);
  });

  it('moves to the following days when the day is full', () => {
    const slots = findFreeSlots({
      employees: [daniel],
      busy: [],
      from: at(2025, 5, 5, 13),
      durationMinutes: 60,
      slotMinutes: 60,
      timeZone: TZ,
      limit: 2,
    });
    expect(slots.map((s) => formatShortSlot(s, TZ))).toEqual(['mié 7 may, 07:00', 'mié 7 may, 08:00']);
  });
});

describe('time off (F14)', () => {
  const monday = (h: number, mi = 0) => at(2025, 5, 5, h, mi);

  it('an absence blocks only that employee; a clinic closure blocks everybody', () => {
    const absence: TimeBlock = { employeeId: 'jc', start: monday(9), end: monday(11) };
    expect(filterAvailableEmployees([daniel, marcos], [], monday(12), 60, TZ, [absence]).map((e) => e.id)).toEqual(['jc', 'ro']);
    expect(filterAvailableEmployees([daniel], [], monday(10), 60, TZ, [absence])).toEqual([]);
    // Half-open: an appointment ending when the absence starts is fine.
    expect(filterAvailableEmployees([daniel], [], monday(8), 60, TZ, [absence]).map((e) => e.id)).toEqual(['jc']);
    // A longer service that runs into the absence is not.
    expect(filterAvailableEmployees([daniel], [], monday(8), 90, TZ, [absence])).toEqual([]);

    const closure: TimeBlock = { employeeId: null, ...localDaysRange('2025-05-05', '2025-05-05', TZ)! };
    expect(filterAvailableEmployees([daniel, marcos], [], monday(12), 60, TZ, [closure])).toEqual([]);
    expect(findBlock('ro', monday(12), 60, [absence, closure])).toBe(closure);
  });

  it('findFreeSlots skips closed days and absences', () => {
    const closure: TimeBlock = { employeeId: null, ...localDaysRange('2025-05-05', '2025-05-05', TZ)! };
    // Monday closed → the first free slots are on Wednesday (Daniel).
    const slots = findFreeSlots({
      employees: [daniel, marcos],
      busy: [],
      blocks: [closure],
      from: monday(9),
      durationMinutes: 60,
      slotMinutes: 60,
      timeZone: TZ,
      limit: 2,
    });
    expect(slots.map((d) => formatShortSlot(d, TZ))).toEqual(['mié 7 may, 07:00', 'mié 7 may, 08:00']);
  });

  it('whole local days are DST safe (23 h and 25 h days)', () => {
    const spring = localDaysRange('2025-03-30', '2025-03-30', TZ)!;
    expect((spring.end.getTime() - spring.start.getTime()) / 3_600_000).toBe(23);
    const autumn = localDaysRange('2025-10-26', '2025-10-26', TZ)!;
    expect((autumn.end.getTime() - autumn.start.getTime()) / 3_600_000).toBe(25);
    const week = localDaysRange('2025-08-04', '2025-08-08', TZ)!;
    expect(week.start).toEqual(at(2025, 8, 4, 0));
    expect(week.end).toEqual(at(2025, 8, 9, 0));
    expect(isWholeLocalDays(week.start, week.end, TZ)).toBe(true);
    expect(isWholeLocalDays(at(2025, 8, 4, 10), at(2025, 8, 4, 12), TZ)).toBe(false);
    expect(localDaysRange('2025-08-09', '2025-08-04', TZ)).toBeNull();
    expect(localDaysRange('9/8/2025', '2025-08-04', TZ)).toBeNull();
  });

  it('formats service durations', () => {
    expect([30, 60, 90, 45, 120].map(formatDuration)).toEqual(['30 min', '1 h', '1 h 30 min', '45 min', '2 h']);
  });
});

describe('scheduledMinutes (F15 occupancy)', () => {
  it('sums the schedule in the range, minus absences and closures, DST safe', () => {
    // Week of Monday 5 May 2025: Daniel works Mon 07:00-13:55 and Wed 07:00-19:55.
    const from = at(2025, 5, 5, 0);
    const to = at(2025, 5, 12, 0);
    expect(scheduledMinutes(daniel, from, to, TZ)).toBe(415 + 775);
    // A 2 h absence on Monday and a closure on Wednesday.
    const blocks = [
      { employeeId: 'jc', start: at(2025, 5, 5, 9), end: at(2025, 5, 5, 11) },
      { employeeId: null, start: at(2025, 5, 7, 0), end: at(2025, 5, 8, 0) },
      { employeeId: 'other', start: at(2025, 5, 5, 7), end: at(2025, 5, 5, 13) },
    ];
    expect(scheduledMinutes(daniel, from, to, TZ, blocks)).toBe(415 - 120);
    // Overlapping blocks are not subtracted twice; the range clips the schedule.
    const overlap = [
      { employeeId: 'jc', start: at(2025, 5, 5, 9), end: at(2025, 5, 5, 11) },
      { employeeId: null, start: at(2025, 5, 5, 10), end: at(2025, 5, 5, 12) },
    ];
    expect(scheduledMinutes(daniel, from, at(2025, 5, 6, 0), TZ, overlap)).toBe(415 - 180);
    expect(scheduledMinutes(daniel, at(2025, 5, 5, 12), at(2025, 5, 5, 13), TZ)).toBe(60);
    // DST: 30 March 2025 (23 h day) — a Sunday 01:00-05:00 shift only lasts 3 real hours.
    const night = { id: 'n', schedule: [{ day: 'sunday' as const, start: '01:00', end: '05:00' }] };
    expect(scheduledMinutes(night, at(2025, 3, 30, 0), at(2025, 3, 31, 0), TZ)).toBe(180);
    expect(scheduledMinutes(oscar, from, to, TZ)).toBe(0);
  });
});
