/**
 * Team of a clinic (F18): panel members and invitations. Access always comes from the Kinde
 * session: a signed-in user without a clinic joins the one that invited their email (the email
 * Kinde verified at sign-in), with the invited role. A person belongs to one clinic only.
 */
import { invitationCutoff, normalizeEmail, type InvitableRole } from '@clinicai/shared';
import type { Db } from '../client';
import { Prisma, type TenantMember } from '../generated/prisma/client';

const isUniqueViolation = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

/**
 * Membership of a signed-in user. Without one, a pending invitation for their email (the oldest,
 * if several clinics invited them) is turned into a membership.
 */
export async function findOrClaimMember(
  db: Db,
  kindeUserId: string,
  email: string | null,
  now: Date = new Date(),
): Promise<TenantMember | null> {
  const existing = await db.tenantMember.findUnique({ where: { kindeUserId } });
  if (existing || !email) return existing;
  try {
    return await db.$transaction(async (tx) => {
      // F34: only invitations of the last INVITATION_TTL_DAYS.
      const invitation = await tx.tenantInvitation.findFirst({
        where: { email: normalizeEmail(email), createdAt: { gte: invitationCutoff(now) } },
        orderBy: { createdAt: 'asc' },
      });
      if (!invitation) return null;
      await tx.tenantInvitation.delete({ where: { id: invitation.id } });
      return tx.tenantMember.create({
        data: {
          tenantId: invitation.tenantId,
          kindeUserId,
          email: normalizeEmail(email),
          role: invitation.role,
          employeeId: invitation.employeeId,
        },
      });
    });
  } catch (error) {
    // Two requests of the same user claimed at once: the other one won.
    if (isUniqueViolation(error)) return db.tenantMember.findUnique({ where: { kindeUserId } });
    throw error;
  }
}

const withEmployee = { employee: { select: { id: true, name: true } } } as const;

export async function listTeam(db: Db, tenantId: string) {
  const [members, invitations] = await Promise.all([
    db.tenantMember.findMany({ where: { tenantId }, include: withEmployee, orderBy: { createdAt: 'asc' } }),
    db.tenantInvitation.findMany({ where: { tenantId }, include: withEmployee, orderBy: { createdAt: 'asc' } }),
  ]);
  return { members, invitations };
}

export type InviteResult =
  | { status: 'invited'; id: string }
  | { status: 'already_member' | 'already_invited' | 'employee_taken' | 'employee_not_found' | 'employee_required' };

/** Invites an email as administrator, or as professional of one employee (one user per employee). */
export async function inviteMember(
  db: Db,
  tenantId: string,
  input: { email: string; role: InvitableRole; employeeId: string | null; invitedBy: string | null; now?: Date },
): Promise<InviteResult> {
  const email = normalizeEmail(input.email);
  const employeeId = input.role === 'professional' ? input.employeeId : null;
  if (input.role === 'professional' && !employeeId) return { status: 'employee_required' };
  // F34: an expired invitation of that email (or of that professional) is replaced by the new one.
  await db.tenantInvitation.deleteMany({
    where: {
      tenantId,
      createdAt: { lt: invitationCutoff(input.now ?? new Date()) },
      OR: [{ email }, ...(employeeId ? [{ employeeId }] : [])],
    },
  });
  if (employeeId) {
    const employee = await db.employee.findFirst({ where: { tenantId, id: employeeId }, select: { id: true } });
    if (!employee) return { status: 'employee_not_found' };
    const taken = await Promise.all([
      db.tenantMember.count({ where: { tenantId, employeeId } }),
      db.tenantInvitation.count({ where: { tenantId, employeeId } }),
    ]);
    if (taken[0] + taken[1] > 0) return { status: 'employee_taken' };
  }
  if (await db.tenantMember.count({ where: { tenantId, email } })) return { status: 'already_member' };
  try {
    const invitation = await db.tenantInvitation.create({
      data: { tenantId, email, role: input.role, employeeId, invitedBy: input.invitedBy },
    });
    return { status: 'invited', id: invitation.id };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const sameEmail = await db.tenantInvitation.count({ where: { tenantId, email } });
    return { status: sameEmail ? 'already_invited' : 'employee_taken' };
  }
}

export async function cancelInvitation(db: Db, tenantId: string, invitationId: string): Promise<boolean> {
  const { count } = await db.tenantInvitation.deleteMany({ where: { tenantId, id: invitationId } });
  return count > 0;
}

export type ChangeRoleResult =
  | 'changed'
  | 'not_found'
  | 'owner'
  | 'self'
  | 'employee_required'
  | 'employee_not_found'
  | 'employee_taken';

/**
 * F21: administrator ↔ professional (or another employee) without removing and inviting again.
 * The owner and the person doing it cannot be changed. Applies from that person's next request.
 */
export async function changeMemberRole(
  db: Db,
  tenantId: string,
  memberId: string,
  actorKindeUserId: string,
  input: { role: InvitableRole; employeeId: string | null },
): Promise<ChangeRoleResult> {
  const member = await db.tenantMember.findFirst({ where: { tenantId, id: memberId } });
  if (!member) return 'not_found';
  if (member.role === 'owner') return 'owner';
  if (member.kindeUserId === actorKindeUserId) return 'self';
  const employeeId = input.role === 'professional' ? input.employeeId : null;
  if (input.role === 'professional') {
    if (!employeeId) return 'employee_required';
    if (!(await db.employee.findFirst({ where: { tenantId, id: employeeId }, select: { id: true } }))) return 'employee_not_found';
    const [members, invitations] = await Promise.all([
      db.tenantMember.count({ where: { tenantId, employeeId, id: { not: member.id } } }),
      db.tenantInvitation.count({ where: { tenantId, employeeId } }),
    ]);
    if (members + invitations > 0) return 'employee_taken';
  }
  try {
    await db.tenantMember.update({ where: { id: member.id }, data: { role: input.role, employeeId } });
  } catch (error) {
    if (isUniqueViolation(error)) return 'employee_taken';
    throw error;
  }
  // F28: the agenda link this person could have had of their former professional stops working.
  if (member.employeeId && member.employeeId !== employeeId) {
    await db.calendarFeed.deleteMany({ where: { tenantId, employeeId: member.employeeId } });
  }
  return 'changed';
}

/**
 * F34: someone (not the owner) leaves the clinic by themselves, e.g. after joining through an
 * invitation they did not want. They can then create their own clinic or accept another invitation.
 */
export async function leaveClinic(db: Db, tenantId: string, kindeUserId: string): Promise<'left' | 'owner' | 'not_found'> {
  const member = await db.tenantMember.findFirst({ where: { tenantId, kindeUserId } });
  if (!member) return 'not_found';
  if (member.role === 'owner') return 'owner';
  await db.tenantMember.delete({ where: { id: member.id } });
  if (member.employeeId) await db.calendarFeed.deleteMany({ where: { tenantId, employeeId: member.employeeId } });
  return 'left';
}

/** Removes someone from the team. The owner and the person doing it cannot be removed. */
export async function removeMember(
  db: Db,
  tenantId: string,
  memberId: string,
  actorKindeUserId: string,
): Promise<'removed' | 'not_found' | 'owner' | 'self'> {
  const member = await db.tenantMember.findFirst({ where: { tenantId, id: memberId } });
  if (!member) return 'not_found';
  if (member.role === 'owner') return 'owner';
  if (member.kindeUserId === actorKindeUserId) return 'self';
  await db.tenantMember.delete({ where: { id: member.id } });
  // F28: whoever leaves the team cannot keep reading that agenda from their phone.
  if (member.employeeId) await db.calendarFeed.deleteMany({ where: { tenantId, employeeId: member.employeeId } });
  return 'removed';
}
