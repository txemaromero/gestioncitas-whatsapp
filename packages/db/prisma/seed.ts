/**
 * Demo seed: tenant "FisioDemo" (fictitious physiotherapy clinic) + a second fictitious tenant used by the isolation tests and demos.
 * Idempotent: both demo tenants are deleted (cascade) and recreated on every run.
 *
 *   pnpm db:seed
 * Optional env: NUMBER_ID (Meta phone_number_id for FisioDemo), SEED_KINDE_USER_ID +
 * SEED_KINDE_EMAIL (links your Kinde user as owner of FisioDemo).
 */
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import {
  addZonedDays,
  getZonedParts,
  isWithinSchedule,
  localDaysRange,
  pad2,
  PRIVACY_NOTICE_VERSION,
  zonedTimeToUtc,
} from '@clinicai/shared';
import { createPrismaClient } from '../src/client';
import type { AppointmentStatus, Prisma } from '../src/generated/prisma/client';
import {
  ASSESSMENT_SERVICE_ID,
  DRY_NEEDLING_SERVICE_ID,
  FISIODEMO_ASSISTANT_INFO,
  FISIODEMO_CONTACT_PHONE,
  FISIODEMO_EMPLOYEES,
  FISIODEMO_SECTOR,
  FISIODEMO_SERVICES,
  SESSION_SERVICE_ID,
} from './seed-data/fisiodemo';

loadEnv({ path: path.resolve(import.meta.dirname, '../.env'), quiet: true });
loadEnv({ path: path.resolve(import.meta.dirname, '../../../.env'), quiet: true });

export const FISIODEMO_ID = '11111111-1111-4111-8111-111111111111';
export const DEMO_NORTE_ID = '22222222-2222-4222-8222-222222222222';
const TZ = 'Europe/Madrid';


const employees = FISIODEMO_EMPLOYEES;

const clients = [
  { id: '11111111-0000-4000-9000-000000000001', name: 'Laura Martínez Pérez', phone: '+34611111111', email: 'laura.martinez@example.com', notes: 'Lumbalgia crónica' },
  { id: '11111111-0000-4000-9000-000000000002', name: 'Carlos Sánchez Gil', phone: '+34622222222', email: 'carlos.sanchez@example.com', notes: null },
  { id: '11111111-0000-4000-9000-000000000003', name: 'María José Ruiz', phone: '+34633333333', email: 'mjruiz@example.com', notes: 'Postoperatorio de rodilla' },
  { id: '11111111-0000-4000-9000-000000000004', name: 'Javier López Navarro', phone: '+34644444444', email: null, notes: null },
  { id: '11111111-0000-4000-9000-000000000005', name: 'Ana Belén Torres', phone: '+34655555555', email: 'anabelen@example.com', notes: 'Embarazada (2º trimestre)' },
  { id: '11111111-0000-4000-9000-000000000006', name: 'Pedro Gómez Vidal', phone: '+34666666666', email: 'pgomez@example.com', notes: null },
];

/** Deterministic appointments spread over the current month, inside each schedule. */
const services = FISIODEMO_SERVICES;

/** Demo time off: a national holiday (8 December) and two days of training for Inés next month. */
function buildTimeOff(now: Date): Prisma.TimeOffCreateManyInput[] {
  const p = getZonedParts(now, TZ);
  const holidayYear = p.month === 12 && p.day > 8 ? p.year + 1 : p.year;
  const holiday = localDaysRange(`${holidayYear}-12-08`, `${holidayYear}-12-08`, TZ);
  const nextMonth = p.month === 12 ? { year: p.year + 1, month: 1 } : { year: p.year, month: p.month + 1 };
  const key = (day: number) => `${nextMonth.year}-${pad2(nextMonth.month)}-${pad2(day)}`;
  const training = localDaysRange(key(3), key(4), TZ);
  const ines = employees.find((e) => e.name === 'Inés');
  const result: Prisma.TimeOffCreateManyInput[] = [];
  if (holiday) {
    result.push({ tenantId: FISIODEMO_ID, employeeId: null, startsAt: holiday.start, endsAt: holiday.end, reason: 'Festivo nacional (Inmaculada Concepción)' });
  }
  if (training && ines) {
    result.push({ tenantId: FISIODEMO_ID, employeeId: ines.id, startsAt: training.start, endsAt: training.end, reason: 'Formación' });
  }
  return result;
}

/**
 * Demo appointments: the current month (past and future) plus 5 previous months of history so
 * the metrics have a trend (F15). Past appointments carry attendance: about one in six (fewer in
 * recent months) was a no-show, and the three most recent ones are left unmarked for the dashboard card.
 */
function buildAppointments(now: Date): Prisma.AppointmentCreateManyInput[] {
  const result: Prisma.AppointmentCreateManyInput[] = [];
  for (let monthsAgo = 5; monthsAgo >= 0; monthsAgo--) result.push(...buildMonth(now, monthsAgo));
  // The three most recent past appointments stay unmarked, whatever the day the seed runs.
  result
    .filter((a) => a.status !== 'cancelled' && new Date(a.date).getTime() < now.getTime())
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 3)
    .forEach((a) => {
      a.attendance = null;
      a.attendanceMarkedAt = null;
    });
  return result;
}

function buildMonth(now: Date, monthsAgo: number): Prisma.AppointmentCreateManyInput[] {
  const p = getZonedParts(now, TZ);
  const index = p.year * 12 + (p.month - 1) - monthsAgo;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const firstOfMonth = zonedTimeToUtc({ year, month, day: 1 }, TZ);
  const result: Prisma.AppointmentCreateManyInput[] = [];
  const hours = [9, 10, 12, 13, 16, 17];
  const bookable = employees.filter((e) => e.schedule.length > 0);
  // No-shows get rarer month after month (the demo story: reminders work).
  const noShowEvery = 4 + (5 - monthsAgo);
  let counter = 0;
  for (let d = 0; d < 31; d++) {
    const day = addZonedDays(firstOfMonth, d, TZ);
    const dp = getZonedParts(day, TZ);
    if (dp.month !== month) break;
    bookable.forEach((employee, index) => {
      // Spread appointments over days and professionals (about one every other day each).
      if ((d + index) % 2 !== 0) return;
      const hour = hours[(d + index * 2) % hours.length] ?? 10;
      const start = zonedTimeToUtc({ year: dp.year, month: dp.month, day: dp.day, hour }, TZ);
      if (!isWithinSchedule(employee.schedule, start, 60, TZ)) return;
      counter++;
      const isPast = start.getTime() < now.getTime();
      const client = clients[(d + index) % clients.length];
      if (!client) return;
      let status: AppointmentStatus = isPast ? 'confirmed' : 'pending';
      if (counter % 7 === 0) status = 'cancelled';
      else if (!isPast && counter % 4 === 0) status = 'confirmed';
      const marked = isPast && status !== 'cancelled';
      result.push({
        tenantId: FISIODEMO_ID,
        clientId: client.id,
        employeeId: employee.id,
        date: start,
        // Mostly sessions, some first assessments and some 30-minute dry needling.
        durationMinutes: counter % 6 === 4 ? 30 : 60,
        serviceId: counter % 6 === 1 ? ASSESSMENT_SERVICE_ID : counter % 6 === 4 ? DRY_NEEDLING_SERVICE_ID : SESSION_SERVICE_ID,
        status,
        source: counter % 2 === 0 ? 'whatsapp' : 'web',
        notes: counter % 5 === 0 ? 'Revisión de evolución' : null,
        // Past appointments were already reminded.
        reminderSentAt: isPast ? start : null,
        attendance: marked ? (counter % noShowEvery === 0 ? 'no_show' : 'attended') : null,
        attendanceMarkedAt: marked ? start : null,
      });
    });
  }
  return result;
}

async function main(): Promise<void> {
  const db = createPrismaClient();
  const now = new Date();
  try {
    await db.tenantConfig.deleteMany({ where: { id: { in: [FISIODEMO_ID, DEMO_NORTE_ID] } } });

    await db.tenantConfig.create({
      data: {
        id: FISIODEMO_ID,
        clinicName: 'FisioDemo',
        phoneNormalized: '+34965000000',
        waPhoneNumberId: process.env.NUMBER_ID || 'mock-fisiodemo',
        timezone: TZ,
        // F27: the demo has its public booking page published at /reservar/fisiodemo.
        publicSlug: 'fisiodemo',
        settings: {
          // F29: the assistant's information is filled in Settings (no uploaded .txt).
          assistantInfo: FISIODEMO_ASSISTANT_INFO,
          slotMinutes: 60,
          reminderHour: '08:00',
          contactPhone: FISIODEMO_CONTACT_PHONE,
          sector: FISIODEMO_SECTOR,
          // F17: the demo shows the waiting list (a real clinic needs the Meta template first).
          waitlistEnabled: true,
          bookingPageEnabled: true,
        },
      },
    });
    await db.employee.createMany({
      data: employees.map((e) => ({
        ...e,
        tenantId: FISIODEMO_ID,
        schedule: e.schedule as Prisma.InputJsonValue,
      })),
    });
    // Every demo client accepted the privacy notice except the last one, so the panel and the
    // simulator also show the "pending acceptance" case (F12).
    const accepted = { consentAt: now, consentChannel: 'whatsapp' as const, consentVersion: PRIVACY_NOTICE_VERSION };
    await db.client.createMany({
      data: clients.map((c, i) => ({ ...c, tenantId: FISIODEMO_ID, ...(i < clients.length - 1 ? accepted : {}) })),
    });
    await db.service.createMany({ data: services.map((s) => ({ ...s, tenantId: FISIODEMO_ID })) });
    const appointments = buildAppointments(now);
    await db.appointment.createMany({ data: appointments });
    const timeOff = buildTimeOff(now);
    await db.timeOff.createMany({ data: timeOff });
    // F26: Laura has a pack of 10 sessions; her last 4 attended appointments spent one each.
    const laura = clients[0]!;
    const pack = await db.clientPack.create({
      data: { tenantId: FISIODEMO_ID, clientId: laura.id, name: 'Bono 10 sesiones', totalSessions: 10 },
    });
    const spent = await db.appointment.findMany({
      where: { tenantId: FISIODEMO_ID, clientId: laura.id, attendance: 'attended' },
      orderBy: { date: 'desc' },
      take: 4,
      select: { id: true },
    });
    await db.appointment.updateMany({ where: { id: { in: spent.map((a) => a.id) } }, data: { packId: pack.id } });
    // F18: Inés is invited to the panel as a professional (fictitious email): whoever signs in
    // with it only sees her diary.
    const ines = employees.find((e) => e.name === 'Inés');
    if (ines) {
      await db.tenantInvitation.create({
        data: { tenantId: FISIODEMO_ID, email: 'ines@fisiodemo.test', role: 'professional', employeeId: ines.id, invitedBy: 'seed' },
      });
    }

    if (process.env.SEED_KINDE_USER_ID) {
      await db.tenantMember.deleteMany({ where: { kindeUserId: process.env.SEED_KINDE_USER_ID } });
      await db.tenantMember.create({
        data: {
          tenantId: FISIODEMO_ID,
          kindeUserId: process.env.SEED_KINDE_USER_ID,
          email: process.env.SEED_KINDE_EMAIL ?? null,
          role: 'owner',
        },
      });
    }

    // Second, fictitious tenant (isolation demos/tests).
    await db.tenantConfig.create({
      data: {
        id: DEMO_NORTE_ID,
        clinicName: 'Clínica Demo Norte',
        phoneNormalized: '+34944000000',
        waPhoneNumberId: 'mock-demo-norte',
        timezone: TZ,
        settings: { slotMinutes: 30, contactPhone: '944 000 000', sector: 'clínica de fisioterapia' },
      },
    });
    const norteEmployee = await db.employee.create({
      data: {
        tenantId: DEMO_NORTE_ID,
        name: 'Iñaki',
        role: 'fisioterapeuta',
        schedule: [
          { day: 'monday', start: '09:00', end: '14:00' },
          { day: 'wednesday', start: '09:00', end: '14:00' },
        ],
      },
    });
    const norteClient = await db.client.create({
      data: {
        tenantId: DEMO_NORTE_ID,
        name: 'Ane Etxeberria',
        phone: '+34688888888',
        email: 'ane@example.com',
        consentAt: now,
        consentChannel: 'web',
        consentVersion: PRIVACY_NOTICE_VERSION,
      },
    });
    await db.appointment.create({
      data: {
        tenantId: DEMO_NORTE_ID,
        clientId: norteClient.id,
        employeeId: norteEmployee.id,
        date: addZonedDays(now, 3, TZ),
        durationMinutes: 30,
        status: 'pending',
        source: 'web',
      },
    });

    console.log(
      `Seed OK → FisioDemo: ${employees.length} empleados, ${clients.length} clientes, ${services.length} servicios, ${appointments.length} citas, ${timeOff.length} ausencias/cierres · Clínica Demo Norte creada.`,
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
