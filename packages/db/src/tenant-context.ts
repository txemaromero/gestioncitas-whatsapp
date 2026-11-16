/**
 * F19: tenant context for database access. Code that works for one clinic runs inside
 * `runWithTenant(tenantId, …)`; the tenant-scoped client then sets `app.tenant_id` in the same
 * transaction as every query, and PostgreSQL row level security (role `clinicai_app`) only lets
 * that clinic's rows through. Outside a context the scoped client refuses to run (fails closed).
 * The repositories keep filtering by `tenantId` as before: this is a second, independent barrier.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Prisma, PrismaClient } from './generated/prisma/client';

type PrismaPromise<T> = Prisma.PrismaPromise<T>;

/**
 * One store per process, shared by every copy of this module: Next.js may bundle the package more
 * than once (server components and route handlers), and the clients are process-wide singletons
 * (`getDatabase`), so a module-local store would not see the context set by another copy.
 */
const STORE_KEY = Symbol.for('clinicai.tenantContext');
const globalStore = globalThis as { [STORE_KEY]?: AsyncLocalStorage<string> };
const storage = (globalStore[STORE_KEY] ??= new AsyncLocalStorage<string>());

export class MissingTenantContextError extends Error {
  constructor() {
    super('Database access without a clinic context: wrap it in runWithTenant() or use the system client');
    this.name = 'MissingTenantContextError';
  }
}

/** Runs `fn` (and everything it awaits or schedules) as work of one clinic. */
export function runWithTenant<T>(tenantId: string, fn: () => T): T {
  return storage.run(tenantId, fn);
}

export function currentTenantId(): string | undefined {
  return storage.getStore();
}

type Raw = (...args: unknown[]) => PrismaPromise<unknown>;
const RAW_METHODS = new Set(['$queryRaw', '$executeRaw', '$queryRawUnsafe', '$executeRawUnsafe']);

/**
 * Wraps a Prisma client so every operation carries the clinic of the current context:
 *  - model operations and raw queries run as `[set_config, operation]` in one short transaction;
 *  - interactive transactions set it first and then run the callback with the plain transaction.
 * Batch transactions (`$transaction([...])`) are not supported (none in the code base).
 */
export function createTenantScopedClient(base: PrismaClient): PrismaClient {
  const setTenant = (client: Pick<PrismaClient, '$queryRaw'>, tenantId: string) =>
    client.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;

  // Errors come back as rejected promises, like any Prisma call.
  const scoped = <T>(operation: () => PrismaPromise<T>): Promise<T> => {
    const tenantId = currentTenantId();
    if (!tenantId) return Promise.reject(new MissingTenantContextError());
    return base.$transaction([setTenant(base, tenantId), operation()]).then(([, result]) => result as T);
  };

  const delegates = new Map<string | symbol, unknown>();
  const delegate = (prop: string | symbol, target: object) => {
    if (!delegates.has(prop)) {
      delegates.set(
        prop,
        new Proxy(target, {
          get(model, method) {
            const value: unknown = Reflect.get(model, method);
            if (typeof value !== 'function') return value;
            return (...args: unknown[]) => scoped(() => (value as Raw).apply(model, args));
          },
        }),
      );
    }
    return delegates.get(prop);
  };

  return new Proxy(base, {
    get(client, prop) {
      if (prop === '$transaction') {
        return (callback: unknown, options?: Parameters<PrismaClient['$transaction']>[1]) => {
          if (typeof callback !== 'function') {
            return Promise.reject(new Error('Batch transactions are not supported by the tenant client'));
          }
          const tenantId = currentTenantId();
          if (!tenantId) return Promise.reject(new MissingTenantContextError());
          return client.$transaction(async (tx) => {
            await setTenant(tx, tenantId);
            return (callback as (t: typeof tx) => Promise<unknown>)(tx);
          }, options);
        };
      }
      const value: unknown = Reflect.get(client, prop);
      if (typeof prop === 'string' && RAW_METHODS.has(prop) && typeof value === 'function') {
        return (...args: unknown[]) => scoped(() => (value as Raw).apply(client, args));
      }
      // Model delegates (client.appointment, client.waitlistEntry…).
      if (typeof prop === 'string' && !prop.startsWith('$') && !prop.startsWith('_') && value !== null && typeof value === 'object') {
        return delegate(prop, value);
      }
      return value;
    },
  });
}
