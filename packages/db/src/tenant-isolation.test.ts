/**
 * F19 — PostgreSQL itself keeps the clinics apart for the application role (`clinicai_app`), even
 * for queries that forget the `tenant_id` filter. The system (owner) connection sees everything.
 */
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createPrismaClient, type Db } from './client';
import { MissingTenantContextError, runWithTenant } from './tenant-context';
import { createAppointment, createClient, createEmployee, createTenant, createTestAppDb, createTestDb } from './testing';

let system: Db;
let app: Db;
/** The restricted role without the tenant-scoped wrapper (nothing sets the clinic). */
let bare: Db;
beforeAll(() => {
  system = createTestDb(inject('databaseUrl'));
  app = createTestAppDb(inject('appDatabaseUrl'));
  bare = createPrismaClient(inject('appDatabaseUrl'));
});
afterAll(async () => {
  await Promise.all([system.$disconnect(), app.$disconnect(), bare.$disconnect()]);
});

async function twoClinics() {
  const make = async (name: string) => {
    const tenant = await createTenant(system, { clinicName: name });
    const employee = await createEmployee(system, tenant.id);
    const client = await createClient(system, tenant.id, { name: `Cliente de ${name}` });
    await createAppointment(system, { tenantId: tenant.id, clientId: client.id, employeeId: employee.id, date: new Date('2031-01-06T09:00:00Z') });
    return { tenant, employee, client };
  };
  return { a: await make('Clínica A'), b: await make('Clínica B') };
}

describe('tenant isolation in the database (F19)', () => {
  it('only shows the rows of the clinic of the context, even without filtering by clinic', async () => {
    const { a, b } = await twoClinics();
    await runWithTenant(a.tenant.id, async () => {
      const clients = await app.client.findMany({ where: { id: { in: [a.client.id, b.client.id] } } });
      expect(clients.map((c) => c.id)).toEqual([a.client.id]);
      expect(await app.appointment.count({ where: { clientId: { in: [a.client.id, b.client.id] } } })).toBe(1);
      expect(await app.tenantConfig.findUnique({ where: { id: b.tenant.id } })).toBeNull();
      const [row] = await app.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM clients WHERE id IN (${a.client.id}::uuid, ${b.client.id}::uuid)`;
      expect(row?.n).toBe(1);
      // Interactive transactions carry the clinic too.
      const inTx = await app.$transaction((tx) => tx.client.count({ where: { id: { in: [a.client.id, b.client.id] } } }));
      expect(inTx).toBe(1);
    });
    // The owner connection is not limited.
    expect(await system.client.count({ where: { id: { in: [a.client.id, b.client.id] } } })).toBe(2);
  });

  it('cannot write into another clinic', async () => {
    const { a, b } = await twoClinics();
    await runWithTenant(a.tenant.id, async () => {
      await expect(app.client.create({ data: { tenantId: b.tenant.id, name: 'Intruso', phone: null } })).rejects.toThrow(/row-level security/);
      expect((await app.client.updateMany({ where: { id: b.client.id }, data: { name: 'Cambiado' } })).count).toBe(0);
      expect((await app.client.deleteMany({ where: { id: b.client.id } })).count).toBe(0);
      // Moving a row of A to B is rejected as well.
      await expect(app.client.update({ where: { id: a.client.id }, data: { tenantId: b.tenant.id } })).rejects.toThrow();
    });
    expect((await system.client.findUniqueOrThrow({ where: { id: b.client.id } })).name).toBe('Cliente de Clínica B');
  });

  it('fails closed without a clinic context', async () => {
    const { a } = await twoClinics();
    await expect(app.client.findMany()).rejects.toBeInstanceOf(MissingTenantContextError);
    await expect(app.$transaction(async () => undefined)).rejects.toBeInstanceOf(MissingTenantContextError);
    // The role on its own (no clinic set) sees nothing and cannot write.
    expect(await bare.client.count()).toBe(0);
    await expect(bare.client.create({ data: { tenantId: a.tenant.id, name: 'Sin clínica', phone: null } })).rejects.toThrow();
    // Least privilege: the application never creates or deletes clinics (onboarding is system work).
    await expect(bare.$executeRaw`DELETE FROM tenant_config`).rejects.toThrow(/permission denied/);
  });

  it('keeps concurrent contexts apart', async () => {
    const { a, b } = await twoClinics();
    const ids = { in: [a.client.id, b.client.id] };
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => {
        const tenant = i % 2 ? b : a;
        return runWithTenant(tenant.tenant.id, async () => (await app.client.findMany({ where: { id: ids } })).map((c) => c.id));
      }),
    );
    results.forEach((ids, i) => expect(ids).toEqual([(i % 2 ? b : a).client.id]));
  });

  it('every application table has row level security and a policy for the application role', async () => {
    const tables = await system.$queryRaw<{ table: string; rls: boolean; policies: number; granted: boolean }[]>`
      SELECT c.relname AS table,
             c.relrowsecurity AS rls,
             (SELECT count(*)::int FROM pg_policies p
                WHERE p.schemaname = 'public' AND p.tablename = c.relname AND 'clinicai_app' = ANY (p.roles)) AS policies,
             has_table_privilege('clinicai_app', c.oid, 'SELECT') AS granted
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'
      ORDER BY c.relname`;
    const exposed = tables.filter((t) => t.granted && (!t.rls || t.policies === 0));
    expect(exposed).toEqual([]);
    expect(tables.filter((t) => t.granted).map((t) => t.table)).toContain('waitlist_entries');
  });
});
