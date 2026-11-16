import {
  cancelInvitation,
  changeMemberRole,
  inviteMember,
  leaveClinic,
  listTeam,
  removeMember,
  type ChangeRoleResult,
  type InviteResult,
} from '@clinicai/db';
import { INVITABLE_ROLES, invitationExpired, memberEmailSchema } from '@clinicai/shared';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { adminProcedure, createTRPCRouter, protectedProcedure } from '../trpc';

const INVITE_ERRORS: Record<Exclude<InviteResult['status'], 'invited'>, { code: 'CONFLICT' | 'NOT_FOUND' | 'BAD_REQUEST'; message: string }> = {
  already_member: { code: 'CONFLICT', message: 'Esa persona ya forma parte del equipo' },
  already_invited: { code: 'CONFLICT', message: 'Ya hay una invitación pendiente para ese email' },
  employee_taken: { code: 'CONFLICT', message: 'Ese profesional ya tiene un usuario o una invitación pendiente' },
  employee_not_found: { code: 'NOT_FOUND', message: 'Empleado no encontrado' },
  employee_required: { code: 'BAD_REQUEST', message: 'Elige qué profesional es' },
};

const CHANGE_ERRORS: Record<Exclude<ChangeRoleResult, 'changed'>, { code: 'CONFLICT' | 'NOT_FOUND' | 'BAD_REQUEST' | 'FORBIDDEN'; message: string }> = {
  not_found: { code: 'NOT_FOUND', message: 'Usuario no encontrado' },
  owner: { code: 'FORBIDDEN', message: 'No se puede cambiar el rol del propietario de la clínica' },
  self: { code: 'BAD_REQUEST', message: 'No puedes cambiar tu propio rol' },
  employee_required: { code: 'BAD_REQUEST', message: 'Elige qué profesional es' },
  employee_not_found: { code: 'NOT_FOUND', message: 'Empleado no encontrado' },
  employee_taken: { code: 'CONFLICT', message: 'Ese profesional ya tiene un usuario o una invitación pendiente' },
};

/**
 * F18: panel users of the clinic. The invited person signs in with that email and joins the
 * clinic automatically (no email is sent: the administrator tells them).
 */
export const teamRouter = createTRPCRouter({
  list: adminProcedure.query(async ({ ctx }) => {
    const { members, invitations } = await listTeam(ctx.db, ctx.tenantId);
    const now = new Date();
    return {
      members: members.map((m) => ({
        id: m.id,
        email: m.email,
        role: m.role,
        employee: m.employee,
        createdAt: m.createdAt,
        isYou: m.kindeUserId === ctx.user.id,
      })),
      invitations: invitations.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        employee: i.employee,
        createdAt: i.createdAt,
        // F34: it can no longer be taken; inviting the same email again replaces it.
        expired: invitationExpired(i.createdAt, now),
      })),
    };
  }),

  invite: adminProcedure
    .input(z.object({ email: memberEmailSchema, role: z.enum(INVITABLE_ROLES), employeeId: z.uuid().nullable() }))
    .mutation(async ({ ctx, input }) => {
      const result = await inviteMember(ctx.db, ctx.tenantId, { ...input, invitedBy: ctx.user.email ?? ctx.user.id });
      if (result.status !== 'invited') throw new TRPCError(INVITE_ERRORS[result.status]);
      return { id: result.id };
    }),

  cancelInvitation: adminProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    if (!(await cancelInvitation(ctx.db, ctx.tenantId, input.id))) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Invitación no encontrada' });
    }
    return { ok: true };
  }),

  /** F21: administrator ↔ professional (or another employee); from that person's next request. */
  changeRole: adminProcedure
    .input(z.object({ id: z.uuid(), role: z.enum(INVITABLE_ROLES), employeeId: z.uuid().nullable() }))
    .mutation(async ({ ctx, input }) => {
      const result = await changeMemberRole(ctx.db, ctx.tenantId, input.id, ctx.user.id, { role: input.role, employeeId: input.employeeId });
      if (result !== 'changed') throw new TRPCError(CHANGE_ERRORS[result]);
      return { ok: true };
    }),

  remove: adminProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    const result = await removeMember(ctx.db, ctx.tenantId, input.id, ctx.user.id);
    if (result === 'not_found') throw new TRPCError({ code: 'NOT_FOUND', message: 'Usuario no encontrado' });
    if (result === 'owner') throw new TRPCError({ code: 'FORBIDDEN', message: 'No se puede quitar al propietario de la clínica' });
    if (result === 'self') throw new TRPCError({ code: 'BAD_REQUEST', message: 'No puedes quitarte a ti mismo del equipo' });
    return { ok: true };
  }),

  /** F34: anyone but the owner can leave the clinic (e.g. after joining through an unwanted invitation). */
  leave: protectedProcedure.mutation(async ({ ctx }) => {
    const result = await leaveClinic(ctx.db, ctx.tenantId, ctx.user.id);
    if (result === 'owner') {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'El propietario no puede salir de su clínica' });
    }
    if (result === 'not_found') throw new TRPCError({ code: 'NOT_FOUND', message: 'No perteneces a esta clínica' });
    return { ok: true };
  }),
});
