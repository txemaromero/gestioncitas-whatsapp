/**
 * F23 — importing clients from a CSV: existing phones are skipped, everything else is created in
 * one statement, with the clinic's consent statement when given.
 */
import { PRIVACY_NOTICE_VERSION } from '@clinicai/shared';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { Db } from '../index';
import { createClient, createTenant, createTestDb } from '../testing';
import { ClientImportError, importClients, planClientImport } from './clients-import';

let db: Db;
beforeAll(() => {
  db = createTestDb(inject('databaseUrl'));
});
afterAll(async () => {
  await db.$disconnect();
});

const CSV = ['Nombre;Móvil;Email', 'Ana García;600 900 001;ana@test.es', 'Luis Pérez;600 900 002;', 'Sin Teléfono;;'].join('\n');

describe('importClients', () => {
  it('skips phones that already exist in the clinic (not in other clinics) and creates the rest', async () => {
    const tenant = await createTenant(db);
    const other = await createTenant(db);
    await createClient(db, tenant.id, { name: 'Ya estaba', phone: '+34600900002' });
    await createClient(db, other.id, { name: 'De otra clínica', phone: '+34600900001' });

    const plan = await planClientImport(db, tenant.id, CSV);
    expect(plan.toImport.map((r) => r.name)).toEqual(['Ana García', 'Sin Teléfono']);
    expect(plan.skipped).toEqual([{ row: 3, name: 'Luis Pérez', reason: 'Ya existe un cliente con ese teléfono en la clínica' }]);
    // The preview saves nothing.
    expect(await db.client.count({ where: { tenantId: tenant.id } })).toBe(1);

    const now = new Date('2031-01-06T10:00:00Z');
    expect(await importClients(db, tenant.id, CSV, { consent: true, now })).toMatchObject({ total: 3, imported: 2 });
    const ana = await db.client.findFirstOrThrow({ where: { tenantId: tenant.id, phone: '+34600900001' } });
    expect(ana).toMatchObject({ name: 'Ana García', email: 'ana@test.es', consentAt: now, consentChannel: 'web', consentVersion: PRIVACY_NOTICE_VERSION });

    // Importing the same file again creates nothing new (the client without phone is repeated).
    const again = await importClients(db, tenant.id, CSV, { consent: false });
    expect(again.imported).toBe(1);
    expect(again.skipped.map((s) => s.row)).toEqual([2, 3]);
  });

  it('without the consent statement the clients must accept the notice in WhatsApp', async () => {
    const tenant = await createTenant(db);
    await importClients(db, tenant.id, 'Nombre;Teléfono\nMarta;600900003', { consent: false });
    expect(await db.client.findFirstOrThrow({ where: { tenantId: tenant.id } })).toMatchObject({ consentAt: null, consentChannel: null });
  });

  it('reports files that cannot be imported', async () => {
    const tenant = await createTenant(db);
    await expect(planClientImport(db, tenant.id, 'Teléfono\n600900004')).rejects.toBeInstanceOf(ClientImportError);
  });
});
