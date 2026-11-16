import { parseSchedule, type ScheduleSlot } from '@clinicai/shared';
import type { Db } from '../client';
import type { Employee, Prisma } from '../generated/prisma/client';

/** Employee with its schedule parsed from JSON. */
export interface EmployeeView {
  id: string;
  tenantId: string;
  name: string;
  role: string;
  schedule: ScheduleSlot[];
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export function toEmployeeView(row: Employee): EmployeeView {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    role: row.role,
    schedule: parseSchedule(row.schedule),
    active: row.active,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface EmployeeInput {
  name: string;
  role: string;
  schedule: ScheduleSlot[];
  active?: boolean;
}

export function employeesRepo(db: Db) {
  return {
    async list(tenantId: string, search?: string): Promise<EmployeeView[]> {
      const q = search?.trim();
      const rows = await db.employee.findMany({
        where: {
          tenantId,
          ...(q
            ? {
                OR: [
                  { name: { contains: q, mode: 'insensitive' } },
                  { role: { contains: q, mode: 'insensitive' } },
                ],
              }
            : {}),
        },
        orderBy: { name: 'asc' },
      });
      return rows.map(toEmployeeView);
    },

    /** Active employees with at least one schedule range (the ones the bot can offer). */
    async listBookable(tenantId: string): Promise<EmployeeView[]> {
      const rows = await db.employee.findMany({ where: { tenantId, active: true }, orderBy: { name: 'asc' } });
      return rows.map(toEmployeeView).filter((e) => e.schedule.length > 0);
    },

    async findById(tenantId: string, id: string): Promise<EmployeeView | null> {
      const row = await db.employee.findFirst({ where: { tenantId, id } });
      return row ? toEmployeeView(row) : null;
    },

    async create(tenantId: string, data: EmployeeInput): Promise<EmployeeView> {
      const row = await db.employee.create({
        data: {
          tenantId,
          name: data.name,
          role: data.role,
          schedule: data.schedule as Prisma.InputJsonValue,
          active: data.active ?? true,
        },
      });
      return toEmployeeView(row);
    },

    async update(tenantId: string, id: string, data: Partial<EmployeeInput>): Promise<EmployeeView> {
      const row = await db.employee.update({
        where: { tenantId_id: { tenantId, id } },
        data: {
          name: data.name,
          role: data.role,
          active: data.active,
          schedule: data.schedule as Prisma.InputJsonValue | undefined,
        },
      });
      return toEmployeeView(row);
    },

    async setActive(tenantId: string, id: string, active: boolean): Promise<EmployeeView> {
      const row = await db.employee.update({ where: { tenantId_id: { tenantId, id } }, data: { active } });
      return toEmployeeView(row);
    },

    async delete(tenantId: string, id: string): Promise<void> {
      await db.employee.delete({ where: { tenantId_id: { tenantId, id } } });
    },

    countFutureAppointments(tenantId: string, id: string, now: Date) {
      return db.appointment.count({
        where: { tenantId, employeeId: id, date: { gte: now }, status: { not: 'cancelled' } },
      });
    },
  };
}

export type EmployeesRepo = ReturnType<typeof employeesRepo>;
