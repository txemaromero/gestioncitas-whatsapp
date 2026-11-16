import { createRepos, findOrClaimMember, getDatabase, logActivity, runWithTenant, type Db, type Repos } from '@clinicai/db';
import { isAdminRole, safeActivityDetails, type MemberRoleValue } from '@clinicai/shared';
import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';
import { ZodError } from 'zod';
import type { AuthUser } from './auth';
import { verifiedEmail } from './identity';

export interface TRPCContext {
  /** Clinic data (F19): usable inside a clinic request only; PostgreSQL limits it to that clinic. */
  db: Db;
  repos: Repos;
  /** Owner connection, only for work before there is a clinic: membership and onboarding. */
  systemRepos: Repos;
  user: AuthUser | null;
  /** Always derived from the session (Kinde sub → tenant_members), never from the client. */
  tenantId: string | null;
  /** F18: role in the clinic and, for professionals, their own employee. */
  role: MemberRoleValue | null;
  employeeId: string | null;
  /** F24: panel user that appears in the activity log. */
  memberId: string | null;
}

/**
 * Builds the context from an already-resolved user (used by the route handler and tests). A user
 * without a clinic joins the one that invited their email, if any (F18).
 */
export async function createContextInner(opts: { db: { system: Db; app: Db }; user: AuthUser | null }): Promise<TRPCContext> {
  // Which clinic the user belongs to is not known yet: owner connection.
  // F32: only a verified email can claim an invitation.
  const member = opts.user ? await findOrClaimMember(opts.db.system, opts.user.id, verifiedEmail(opts.user)) : null;
  return {
    db: opts.db.app,
    repos: createRepos(opts.db.app),
    systemRepos: createRepos(opts.db.system),
    user: opts.user,
    tenantId: member?.tenantId ?? null,
    role: member?.role ?? null,
    employeeId: member?.employeeId ?? null,
    memberId: member?.id ?? null,
  };
}

export async function createTRPCContext(): Promise<TRPCContext> {
  const { getAuthUser } = await import('./auth');
  return createContextInner({ db: getDatabase(), user: await getAuthUser() });
}

const t = initTRPC.context<TRPCContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError: error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    };
  },
});

export const createTRPCRouter = t.router;
export const createCallerFactory = t.createCallerFactory;
export const publicProcedure = t.procedure;

/** Logged-in user (may not belong to a tenant yet: onboarding). */
export const authedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Inicia sesión para continuar' });
  return next({ ctx: { ...ctx, user: ctx.user } });
});

/** F24: queries that are logged too (a client's record is personal, possibly health, data). */
const LOGGED_QUERIES = new Set(['clients.get', 'clients.export']);
/** Changes nothing: not logged. */
const UNLOGGED_MUTATIONS = new Set(['clients.importPreview']);

const asId = (value: unknown) => (typeof value === 'string' && value.length <= 64 ? value : null);
/** The panel reloads a record it shows (e.g. on window focus): one "viewed" entry per 10 minutes. */
const VIEW_DEDUP_MS = 10 * 60 * 1000;

/**
 * F24: one entry per successful change in the panel (and per client record viewed or exported):
 * who, what (the procedure), on what (ids) and safe details only (`safeActivityDetails`).
 * Never undoes the action if the entry cannot be stored.
 */
/** Appointment before the change (the delete leaves nothing to read afterwards). */
type AppointmentSnapshot = { clientId: string; date: Date; employeeId: string } | null;

async function appointmentSnapshot(ctx: { db: Db; tenantId: string }, path: string, rawInput: unknown): Promise<AppointmentSnapshot> {
  const id = rawInput && typeof rawInput === 'object' ? asId((rawInput as Record<string, unknown>).id) : null;
  if (!path.startsWith('appointments.') || !id) return null;
  return ctx.db.appointment
    .findFirst({ where: { tenantId: ctx.tenantId, id }, select: { clientId: true, date: true, employeeId: true } })
    .catch(() => null);
}

async function recordPanelActivity(
  ctx: { db: Db; tenantId: string; memberId: string | null; user: AuthUser },
  path: string,
  type: string,
  rawInput: unknown,
  data: unknown,
  before: AppointmentSnapshot = null,
): Promise<void> {
  try {
    const input = rawInput && typeof rawInput === 'object' ? (rawInput as Record<string, unknown>) : {};
    if (type === 'query') {
      const recent = await ctx.db.activityLog.findFirst({
        where: {
          tenantId: ctx.tenantId,
          actorMemberId: ctx.memberId,
          action: path,
          entityId: asId(input.id),
          createdAt: { gt: new Date(Date.now() - VIEW_DEDUP_MS) },
        },
        select: { id: true },
      });
      if (recent) return;
    }
    const output = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
    const entityType = path.split('.')[0] ?? null;
    let clientId =
      entityType === 'clients'
        ? (asId(input.id) ?? asId(output.id))
        : (asId(input.clientId) ?? asId(output.clientId) ?? before?.clientId ?? null);
    // An erased client leaves no link behind (the entry keeps only the id of the deleted record).
    if (path === 'clients.delete') clientId = null;
    await logActivity(ctx.db, ctx.tenantId, {
      actorType: 'member',
      actorMemberId: ctx.memberId,
      actorLabel: ctx.user.email ?? ctx.user.id,
      action: path,
      entityType,
      entityId: asId(input.id) ?? asId(output.id),
      clientId,
      // What the appointment was, then what changed (the input wins: e.g. the new start).
      details: safeActivityDetails(before ? { start: before.date, employeeId: before.employeeId } : null, input, output),
    });
  } catch (error) {
    console.warn('activity not logged', path, error instanceof Error ? error.message : error);
  }
}

/**
 * Logged-in user with a tenant: injects `ctx.tenantId` for every tenant-scoped query, and
 * `ctx.ownEmployeeId` (F18): the employee a professional is limited to, undefined for admins.
 */
export const protectedProcedure = authedProcedure.use(({ ctx, next, path, type, getRawInput }) => {
  if (!ctx.tenantId || !ctx.role) throw new TRPCError({ code: 'FORBIDDEN', message: 'Tu usuario no pertenece a ninguna clínica' });
  if (ctx.role === 'professional' && !ctx.employeeId) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Tu usuario no tiene un profesional asignado' });
  }
  const ownEmployeeId = ctx.role === 'professional' ? (ctx.employeeId ?? undefined) : undefined;
  const { tenantId, role } = ctx;
  // F19: the whole procedure runs as work of this clinic (row level security in PostgreSQL).
  return runWithTenant(tenantId, async () => {
    const logged = type === 'mutation' ? !UNLOGGED_MUTATIONS.has(path) : LOGGED_QUERIES.has(path);
    const rawInput = logged ? await getRawInput().catch(() => undefined) : undefined;
    const before = logged ? await appointmentSnapshot({ db: ctx.db, tenantId }, path, rawInput) : null;
    const result = await next({ ctx: { ...ctx, tenantId, role, ownEmployeeId } });
    if (result.ok && logged) {
      await recordPanelActivity({ ...ctx, tenantId }, path, type, rawInput, 'data' in result ? result.data : undefined, before);
    }
    return result;
  });
});

/** Owner and administrators only (F18): settings, team, employees, clients, metrics… */
export const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (!isAdminRole(ctx.role)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Solo los administradores de la clínica pueden hacer esto' });
  }
  return next({ ctx });
});

/** A professional can only touch the appointments of their own employee (F18). */
export function assertOwnEmployee(ctx: { ownEmployeeId: string | undefined }, employeeId: string): void {
  if (ctx.ownEmployeeId && ctx.ownEmployeeId !== employeeId) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Solo puedes gestionar tus propias citas' });
  }
}
