import type { Db } from '../client';

export interface ServiceInput {
  name: string;
  durationMinutes: number;
  active?: boolean;
}

/** Services of a clinic (F14). Every method takes `tenantId` first. */
export function servicesRepo(db: Db) {
  return {
    list(tenantId: string, options: { activeOnly?: boolean } = {}) {
      return db.service.findMany({
        where: { tenantId, ...(options.activeOnly ? { active: true } : {}) },
        orderBy: { name: 'asc' },
      });
    },

    /** For the panel: each service with the number of appointments that use it. */
    listWithUsage(tenantId: string) {
      return db.service.findMany({
        where: { tenantId },
        orderBy: { name: 'asc' },
        include: { _count: { select: { appointments: true } } },
      });
    },

    findById(tenantId: string, id: string) {
      return db.service.findFirst({ where: { tenantId, id } });
    },

    create(tenantId: string, input: ServiceInput) {
      return db.service.create({ data: { tenantId, ...input } });
    },

    update(tenantId: string, id: string, input: Partial<ServiceInput>) {
      return db.service.update({ where: { tenantId_id: { tenantId, id } }, data: input });
    },

    /** A service used by appointments is kept (deactivate it instead) so the history stays intact. */
    async delete(tenantId: string, id: string): Promise<'deleted' | 'in_use' | 'not_found'> {
      const used = await db.appointment.count({ where: { tenantId, serviceId: id } });
      if (used > 0) return 'in_use';
      const { count } = await db.service.deleteMany({ where: { tenantId, id } });
      return count > 0 ? 'deleted' : 'not_found';
    },
  };
}

export type ServicesRepo = ReturnType<typeof servicesRepo>;
