/**
 * F18 — team of a clinic: invitations, joining on first sign-in, removal rules and the DB
 * constraints that link a professional to exactly one employee of the same clinic.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { Db } from '../index';
import { createEmployee, createTenant, createTestDb } from '../testing';
import { cancelInvitation, changeMemberRole, findOrClaimMember, inviteMember, listTeam, removeMember } from './team';

let db: Db;
beforeAll(() => {
  db = createTestDb(inject('databaseUrl'));
});
afterAll(async () => {
  await db.$disconnect();
});

const kindeId = () => `kp_${randomUUID()}`;
const email = () => `persona-${randomUUID().slice(0, 8)}@clinica.test`;

async function clinic() {
  const tenant = await createTenant(db);
  const owner = await db.tenantMember.create({ data: { tenantId: tenant.id, kindeUserId: kindeId(), email: 'owner@clinica.test', role: 'owner' } });
  const ines = await createEmployee(db, tenant.id, { name: 'Inés' });
  return { tenant, owner, ines };
}

describe('inviteMember', () => {
  it('invites administrators and professionals (one user per professional)', async () => {
    const c = await clinic();
    const invited = email();
    expect(await inviteMember(db, c.tenant.id, { email: invited.toUpperCase(), role: 'professional', employeeId: c.ines.id, invitedBy: null })).toMatchObject({
      status: 'invited',
    });
    expect((await db.tenantInvitation.findFirstOrThrow({ where: { tenantId: c.tenant.id } })).email).toBe(invited);
    expect(await inviteMember(db, c.tenant.id, { email: invited, role: 'admin', employeeId: null, invitedBy: null })).toEqual({ status: 'already_invited' });
    expect(await inviteMember(db, c.tenant.id, { email: email(), role: 'professional', employeeId: c.ines.id, invitedBy: null })).toEqual({
      status: 'employee_taken',
    });
    expect(await inviteMember(db, c.tenant.id, { email: email(), role: 'professional', employeeId: null, invitedBy: null })).toEqual({
      status: 'employee_required',
    });
    expect(await inviteMember(db, c.tenant.id, { email: 'owner@clinica.test', role: 'admin', employeeId: null, invitedBy: null })).toEqual({
      status: 'already_member',
    });
    // An employee of another clinic cannot be used.
    const other = await clinic();
    expect(await inviteMember(db, c.tenant.id, { email: email(), role: 'professional', employeeId: other.ines.id, invitedBy: null })).toEqual({
      status: 'employee_not_found',
    });
    // Administrators are never linked to an employee.
    expect(await inviteMember(db, c.tenant.id, { email: email(), role: 'admin', employeeId: other.ines.id, invitedBy: null })).toMatchObject({
      status: 'invited',
    });
  });
});

describe('findOrClaimMember', () => {
  it('turns the invitation into a membership on the first sign-in with that email', async () => {
    const c = await clinic();
    const invited = email();
    await inviteMember(db, c.tenant.id, { email: invited, role: 'professional', employeeId: c.ines.id, invitedBy: 'owner@clinica.test' });
    const user = kindeId();
    expect(await findOrClaimMember(db, user, null)).toBeNull();
    expect(await findOrClaimMember(db, kindeId(), 'otra@clinica.test')).toBeNull();
    const member = await findOrClaimMember(db, user, invited.toUpperCase());
    expect(member).toMatchObject({ tenantId: c.tenant.id, role: 'professional', employeeId: c.ines.id, email: invited });
    expect(await db.tenantInvitation.count({ where: { tenantId: c.tenant.id } })).toBe(0);
    // Later visits find the membership; nobody else can use the same invitation.
    expect((await findOrClaimMember(db, user, invited))?.id).toBe(member?.id);
    expect(await findOrClaimMember(db, kindeId(), invited)).toBeNull();
  });

  it('keeps a person in their current clinic', async () => {
    const a = await clinic();
    const b = await clinic();
    const user = kindeId();
    const invited = email();
    await inviteMember(db, a.tenant.id, { email: invited, role: 'admin', employeeId: null, invitedBy: null });
    await findOrClaimMember(db, user, invited);
    await inviteMember(db, b.tenant.id, { email: invited, role: 'admin', employeeId: null, invitedBy: null });
    expect((await findOrClaimMember(db, user, invited))?.tenantId).toBe(a.tenant.id);
    expect(await db.tenantInvitation.count({ where: { tenantId: b.tenant.id } })).toBe(1);
  });
});

describe('team rules', () => {
  it('never removes the owner or the person doing it; cancels invitations', async () => {
    const c = await clinic();
    const admin = await db.tenantMember.create({ data: { tenantId: c.tenant.id, kindeUserId: kindeId(), email: 'admin@clinica.test', role: 'admin' } });
    const pro = await db.tenantMember.create({
      data: { tenantId: c.tenant.id, kindeUserId: kindeId(), email: 'ines@clinica.test', role: 'professional', employeeId: c.ines.id },
    });
    expect(await removeMember(db, c.tenant.id, c.owner.id, admin.kindeUserId)).toBe('owner');
    expect(await removeMember(db, c.tenant.id, admin.id, admin.kindeUserId)).toBe('self');
    const other = await clinic();
    expect(await removeMember(db, other.tenant.id, pro.id, other.owner.kindeUserId)).toBe('not_found');
    expect(await removeMember(db, c.tenant.id, pro.id, admin.kindeUserId)).toBe('removed');

    const invitation = await inviteMember(db, c.tenant.id, { email: email(), role: 'admin', employeeId: null, invitedBy: null });
    if (invitation.status !== 'invited') throw new Error('unexpected');
    expect(await cancelInvitation(db, other.tenant.id, invitation.id)).toBe(false);
    expect(await cancelInvitation(db, c.tenant.id, invitation.id)).toBe(true);
    expect((await listTeam(db, c.tenant.id)).members.map((m) => m.role)).toEqual(['owner', 'admin']);
  });

  it('the database requires an employee of the same clinic for professionals only', async () => {
    const c = await clinic();
    const other = await clinic();
    const base = { tenantId: c.tenant.id, kindeUserId: kindeId(), email: email() };
    await expect(db.tenantMember.create({ data: { ...base, role: 'professional' } })).rejects.toThrow();
    await expect(db.tenantMember.create({ data: { ...base, role: 'admin', employeeId: c.ines.id } })).rejects.toThrow();
    await expect(db.tenantMember.create({ data: { ...base, role: 'professional', employeeId: other.ines.id } })).rejects.toThrow();
    await expect(db.tenantInvitation.create({ data: { tenantId: c.tenant.id, email: 'Mayus@clinica.test', role: 'admin' } })).rejects.toThrow();
    await expect(db.tenantInvitation.create({ data: { tenantId: c.tenant.id, email: email(), role: 'owner' } })).rejects.toThrow();
  });

  it('deleting an employee removes their panel user and invitation', async () => {
    const c = await clinic();
    const luis = await createEmployee(db, c.tenant.id, { name: 'Luis' });
    await db.tenantMember.create({
      data: { tenantId: c.tenant.id, kindeUserId: kindeId(), email: email(), role: 'professional', employeeId: c.ines.id },
    });
    await inviteMember(db, c.tenant.id, { email: email(), role: 'professional', employeeId: luis.id, invitedBy: null });
    await db.employee.deleteMany({ where: { tenantId: c.tenant.id, id: { in: [c.ines.id, luis.id] } } });
    const team = await listTeam(db, c.tenant.id);
    expect(team.members.map((m) => m.role)).toEqual(['owner']);
    expect(team.invitations).toEqual([]);
  });
});

describe('changeMemberRole (F21)', () => {
  it('switches between administrator and professional with the same rules as invitations', async () => {
    const c = await clinic();
    const luis = await createEmployee(db, c.tenant.id, { name: 'Luis' });
    const admin = await db.tenantMember.create({ data: { tenantId: c.tenant.id, kindeUserId: kindeId(), email: email(), role: 'admin' } });
    const other = await db.tenantMember.create({ data: { tenantId: c.tenant.id, kindeUserId: kindeId(), email: email(), role: 'admin' } });
    const actor = c.owner.kindeUserId;

    expect(await changeMemberRole(db, c.tenant.id, c.owner.id, admin.kindeUserId, { role: 'admin', employeeId: null })).toBe('owner');
    expect(await changeMemberRole(db, c.tenant.id, admin.id, admin.kindeUserId, { role: 'professional', employeeId: c.ines.id })).toBe('self');
    expect(await changeMemberRole(db, c.tenant.id, admin.id, actor, { role: 'professional', employeeId: null })).toBe('employee_required');
    const elsewhere = await clinic();
    expect(await changeMemberRole(db, c.tenant.id, admin.id, actor, { role: 'professional', employeeId: elsewhere.ines.id })).toBe(
      'employee_not_found',
    );
    expect(await changeMemberRole(db, elsewhere.tenant.id, admin.id, actor, { role: 'admin', employeeId: null })).toBe('not_found');

    expect(await changeMemberRole(db, c.tenant.id, admin.id, actor, { role: 'professional', employeeId: c.ines.id })).toBe('changed');
    expect(await db.tenantMember.findUniqueOrThrow({ where: { id: admin.id } })).toMatchObject({ role: 'professional', employeeId: c.ines.id });
    // Inés already has a user; Luis has a pending invitation.
    expect(await changeMemberRole(db, c.tenant.id, other.id, actor, { role: 'professional', employeeId: c.ines.id })).toBe('employee_taken');
    await inviteMember(db, c.tenant.id, { email: email(), role: 'professional', employeeId: luis.id, invitedBy: null });
    expect(await changeMemberRole(db, c.tenant.id, other.id, actor, { role: 'professional', employeeId: luis.id })).toBe('employee_taken');
    // Keeping the same employee is fine; back to administrator clears it.
    expect(await changeMemberRole(db, c.tenant.id, admin.id, actor, { role: 'professional', employeeId: c.ines.id })).toBe('changed');
    expect(await changeMemberRole(db, c.tenant.id, admin.id, actor, { role: 'admin', employeeId: c.ines.id })).toBe('changed');
    expect(await db.tenantMember.findUniqueOrThrow({ where: { id: admin.id } })).toMatchObject({ role: 'admin', employeeId: null });
  });
});
