/**
 * Availability over the DB. The rules themselves are pure functions in @clinicai/shared,
 * so the bot and the web apply exactly the same logic.
 */
import {
  addMinutes,
  addZonedDays,
  filterAvailableEmployees,
  findBlock,
  findFreeSlots,
  hasConflict,
  isWithinSchedule,
  startOfZonedDay,
} from '@clinicai/shared';
import type { Db } from '../client';
import { appointmentsRepo } from '../repos/appointments';
import { employeesRepo, type EmployeeView } from '../repos/employees';
import { tenantsRepo } from '../repos/tenants';
import { timeOffRepo } from '../repos/time-off';

async function tenantTimeZone(db: Db, tenantId: string, timeZone?: string): Promise<string> {
  if (timeZone) return timeZone;
  const tenant = await tenantsRepo(db).findById(tenantId);
  if (!tenant) throw new Error(`Tenant not found: ${tenantId}`);
  return tenant.timezone;
}

/**
 * Active employees whose schedule (in the tenant zone) covers [start, start + duration],
 * who have no overlapping non-cancelled appointment and no time off (absence or closure).
 */
export async function getAvailableEmployees(
  db: Db,
  tenantId: string,
  start: Date,
  durationMinutes: number,
  timeZone?: string,
): Promise<EmployeeView[]> {
  const tz = await tenantTimeZone(db, tenantId, timeZone);
  const employees = await employeesRepo(db).listBookable(tenantId);
  if (employees.length === 0) return [];
  const end = addMinutes(start, durationMinutes);
  const ids = employees.map((e) => e.id);
  const [busy, blocks] = await Promise.all([
    appointmentsRepo(db).findBusy(tenantId, start, end, ids),
    timeOffRepo(db).findBlocks(tenantId, start, end, ids),
  ]);
  return filterAvailableEmployees(employees, busy, start, durationMinutes, tz, blocks);
}

/** Up to `limit` free start instants from `from` onwards (same day or following days). */
export async function findNearbySlots(
  db: Db,
  tenantId: string,
  options: {
    from: Date;
    durationMinutes: number;
    slotMinutes: number;
    timeZone?: string;
    limit?: number;
    maxDays?: number;
  },
): Promise<Date[]> {
  const tz = await tenantTimeZone(db, tenantId, options.timeZone);
  const maxDays = options.maxDays ?? 7;
  const employees = await employeesRepo(db).listBookable(tenantId);
  if (employees.length === 0) return [];
  const rangeStart = startOfZonedDay(options.from, tz);
  const rangeEnd = addZonedDays(rangeStart, maxDays + 1, tz);
  const [busy, blocks] = await Promise.all([
    appointmentsRepo(db).findBusy(tenantId, rangeStart, rangeEnd),
    timeOffRepo(db).findBlocks(tenantId, rangeStart, rangeEnd),
  ]);
  return findFreeSlots({
    employees,
    busy,
    blocks,
    from: options.from,
    durationMinutes: options.durationMinutes,
    slotMinutes: options.slotMinutes,
    timeZone: tz,
    limit: options.limit ?? 3,
    maxDays,
  });
}

export interface EmployeeSlotCheck {
  exists: boolean;
  active: boolean;
  withinSchedule: boolean;
  conflict: boolean;
  /** Time off overlapping the slot (F14): blocks the booking, it cannot be overridden. */
  timeOff: { clinicWide: boolean; reason: string | null; start: Date; end: Date } | null;
}

/** Diagnostic check used by the web form (warns, and may be overridden by the admin). */
export async function checkEmployeeSlot(
  db: Db,
  tenantId: string,
  input: {
    employeeId: string;
    start: Date;
    durationMinutes: number;
    ignoreAppointmentId?: string;
    timeZone?: string;
  },
): Promise<EmployeeSlotCheck> {
  const tz = await tenantTimeZone(db, tenantId, input.timeZone);
  const employee = await employeesRepo(db).findById(tenantId, input.employeeId);
  if (!employee) return { exists: false, active: false, withinSchedule: false, conflict: false, timeOff: null };
  const end = addMinutes(input.start, input.durationMinutes);
  const [busy, blocks] = await Promise.all([
    appointmentsRepo(db).findBusy(tenantId, input.start, end, [employee.id]),
    timeOffRepo(db).findBlocks(tenantId, input.start, end, [employee.id]),
  ]);
  const block = findBlock(employee.id, input.start, input.durationMinutes, blocks);
  return {
    exists: true,
    active: employee.active,
    withinSchedule: isWithinSchedule(employee.schedule, input.start, input.durationMinutes, tz),
    conflict: hasConflict(employee.id, input.start, input.durationMinutes, busy, input.ignoreAppointmentId),
    timeOff: block ? { clinicWide: block.employeeId === null, reason: block.reason, start: block.start, end: block.end } : null,
  };
}
