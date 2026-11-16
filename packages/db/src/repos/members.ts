import type { Db } from '../client';

export function membersRepo(db: Db) {
  return {
    /** Kinde `sub` → membership (tenant of the logged-in admin). */
    findByKindeUserId(kindeUserId: string) {
      return db.tenantMember.findUnique({ where: { kindeUserId } });
    },

    listByTenant(tenantId: string) {
      return db.tenantMember.findMany({
        where: { tenantId },
        include: { employee: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'asc' },
      });
    },
  };
}

export type MembersRepo = ReturnType<typeof membersRepo>;
