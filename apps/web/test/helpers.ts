import { randomUUID } from 'node:crypto';
import type { Db } from '@clinicai/db';
import { createTestAppDb, createTestDb } from '@clinicai/db/testing';
import { inject } from 'vitest';
import { createCaller } from '../src/server/routers/_app';
import { createContextInner } from '../src/server/trpc';

let db: Db | undefined;
let appDb: Db | undefined;

/** Owner connection: setup and checks of the tests. */
export function getTestDb(): Db {
  db ??= createTestDb(inject('databaseUrl'));
  return db;
}

/** F19: the routers work on the restricted role, with row level security, as in production. */
export function getTestAppDb(): Db {
  appDb ??= createTestAppDb(inject('appDatabaseUrl'));
  return appDb;
}

export async function disconnectTestDb(): Promise<void> {
  await Promise.all([db?.$disconnect(), appDb?.$disconnect()]);
  db = undefined;
  appDb = undefined;
}

export async function callerFor(user: { id: string; email?: string; emailVerified?: boolean } | null) {
  const ctx = await createContextInner({
    db: { system: getTestDb(), app: getTestAppDb() },
    user: user ? { id: user.id, email: user.email ?? null, emailVerified: user.emailVerified ?? true, name: null, picture: null } : null,
  });
  return createCaller(ctx);
}

/** A new Kinde user that owns a freshly onboarded clinic. */
export async function newOwner(clinicName = 'Clínica Router') {
  const user = { id: `kp_${randomUUID()}`, email: 'owner@test.es' };
  const caller = await callerFor(user);
  const tenant = await caller.tenant.onboarding({ clinicName, contactPhone: '965 000 000' });
  // Re-create the caller so the context picks up the new membership.
  return { user, tenant, caller: await callerFor(user) };
}
