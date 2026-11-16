import {
  assistantInfoSchema,
  buildDefaultFaqPrompt,
  suggestedServiceLines,
  DEFAULT_TIMEZONE,
  FAQ_PROMPT_MAX_BYTES,
  MIN_NOTICE_HOUR_OPTIONS,
  normalizePhone,
  privacyPolicyUrlSchema,
  publicSlugSchema,
  REMINDER_DAYS_BEFORE_OPTIONS,
  SECOND_REMINDER_HOUR_OPTIONS,
  RETENTION_MONTH_OPTIONS,
} from '@clinicai/shared';
import { encryptSecret, maskSecret, decryptSecret } from '@clinicai/shared/crypto';
import { isUniqueViolation, type Tenant } from '@clinicai/db';
import { TRPCError } from '@trpc/server';
import QRCode from 'qrcode';
import { z } from 'zod';
import { publicBaseUrl } from '../booking-page';
import { encryptionKey } from '../encryption-key';
import { verifiedEmail } from '../identity';
import { isPlatformAdmin } from '../platform';
import { verifyWhatsAppNumber } from '../whatsapp-number';
import { adminProcedure, authedProcedure, createTRPCRouter } from '../trpc';

export const SLOT_OPTIONS = [15, 20, 30, 45, 60, 90, 120] as const;

function maskedToken(tenant: Tenant): string | null {
  if (!tenant.waAccessTokenEnc) return null;
  try {
    return maskSecret(decryptSecret(tenant.waAccessTokenEnc, encryptionKey()));
  } catch {
    return '••••';
  }
}

/** Public view of the tenant for the panel (never returns the token in clear). */
function toView(tenant: Tenant) {
  return {
    id: tenant.id,
    clinicName: tenant.clinicName,
    phoneNormalized: tenant.phoneNormalized,
    timezone: tenant.timezone,
    contactPhone: tenant.settings.contactPhone,
    slotMinutes: tenant.settings.slotMinutes,
    reminderHour: tenant.settings.reminderHour,
    reminderDaysBefore: tenant.settings.reminderDaysBefore,
    secondReminderHours: tenant.settings.secondReminderHours,
    minNoticeHours: tenant.settings.minNoticeHours,
    waitlistEnabled: tenant.settings.waitlistEnabled,
    packNoShowSpends: tenant.settings.packNoShowSpends,
    sector: tenant.settings.sector,
    hasCustomFaqPrompt: Boolean(tenant.settings.faqPrompt?.trim()),
    waPhoneNumberId: tenant.waPhoneNumberId,
    waTokenMasked: maskedToken(tenant),
    chatwootUrl: tenant.settings.chatwoot?.baseUrl ?? process.env.NEXT_PUBLIC_CHATWOOT_URL ?? null,
    privacyPolicyUrl: tenant.settings.privacyPolicyUrl,
    retentionMonths: tenant.settings.retentionMonths,
    // F27: public booking page.
    bookingPageEnabled: tenant.settings.bookingPageEnabled,
    publicSlug: tenant.publicSlug,
    bookingPageUrl: tenant.publicSlug ? `${publicBaseUrl()}/reservar/${tenant.publicSlug}` : null,
  };
}
export type TenantView = ReturnType<typeof toView>;

const updateInput = z.object({
  clinicName: z.string().trim().min(2, 'Mínimo 2 caracteres').max(80),
  contactPhone: z.string().trim().max(30),
  slotMinutes: z.number().int().refine((v) => (SLOT_OPTIONS as readonly number[]).includes(v), 'Duración no válida'),
  reminderHour: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  /** F30: first reminder 1 or 2 days before; optional second one the same day. */
  reminderDaysBefore: z
    .number()
    .int()
    .refine((v) => (REMINDER_DAYS_BEFORE_OPTIONS as readonly number[]).includes(v), 'Antelación no válida')
    .optional(),
  secondReminderHours: z
    .number()
    .int()
    .refine((v) => (SECOND_REMINDER_HOUR_OPTIONS as readonly number[]).includes(v), 'Horas no válidas')
    .nullable()
    .optional(),
  /** F13: hours before an appointment until which clients can cancel or change it by WhatsApp. */
  minNoticeHours: z
    .number()
    .int()
    .refine((v) => (MIN_NOTICE_HOUR_OPTIONS as readonly number[]).includes(v), 'Antelación no válida')
    .optional(),
  /** F17: the bot offers the waiting list (needs the Meta template approved). */
  waitlistEnabled: z.boolean().optional(),
  /** F26: a no-show also spends a session of the client's pack. */
  packNoShowSpends: z.boolean().optional(),
});

const privacyInput = z.object({
  /** Empty string → no link in the bot notice. */
  privacyPolicyUrl: z.union([z.literal(''), privacyPolicyUrlSchema]),
  retentionMonths: z
    .number()
    .int()
    .refine((v) => (RETENTION_MONTH_OPTIONS as readonly number[]).includes(v), 'Plazo no válido')
    .nullable(),
});

const whatsappInput = z.object({
  waPhoneNumberId: z.string().trim().max(64).nullable(),
  phoneNormalized: z.string().trim().max(30).nullable(),
  /** New token (plain); undefined keeps the current one, null removes it. */
  waAccessToken: z.string().trim().min(10).max(1000).nullable().optional(),
});

export const tenantRouter = createTRPCRouter({
  get: adminProcedure.query(async ({ ctx }) => {
    const tenant = await ctx.repos.tenants.findById(ctx.tenantId);
    if (!tenant) throw new TRPCError({ code: 'NOT_FOUND' });
    return toView(tenant);
  }),

  update: adminProcedure.input(updateInput).mutation(async ({ ctx, input }) => {
    const tenant = await ctx.repos.tenants.update(ctx.tenantId, {
      clinicName: input.clinicName,
      settings: {
        contactPhone: input.contactPhone,
        slotMinutes: input.slotMinutes,
        reminderHour: input.reminderHour,
        ...(input.reminderDaysBefore === undefined ? {} : { reminderDaysBefore: input.reminderDaysBefore }),
        ...(input.secondReminderHours === undefined ? {} : { secondReminderHours: input.secondReminderHours }),
        ...(input.minNoticeHours === undefined ? {} : { minNoticeHours: input.minNoticeHours }),
        ...(input.waitlistEnabled === undefined ? {} : { waitlistEnabled: input.waitlistEnabled }),
        ...(input.packNoShowSpends === undefined ? {} : { packNoShowSpends: input.packNoShowSpends }),
      },
    });
    return toView(tenant);
  }),

  /**
   * F27: publishes (or hides) the public booking page and sets its address. It needs the clinic's
   * WhatsApp number: the page opens a chat with it.
   */
  updateBookingPage: adminProcedure
    .input(z.object({ enabled: z.boolean(), slug: publicSlugSchema }))
    .mutation(async ({ ctx, input }) => {
      const current = await ctx.repos.tenants.findById(ctx.tenantId);
      if (!current) throw new TRPCError({ code: 'NOT_FOUND' });
      if (input.enabled && !current.phoneNormalized) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Indica antes el número de WhatsApp de la clínica (en «WhatsApp»).' });
      }
      try {
        const tenant = await ctx.repos.tenants.update(ctx.tenantId, { publicSlug: input.slug, settings: { bookingPageEnabled: input.enabled } });
        return toView(tenant);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new TRPCError({ code: 'CONFLICT', message: 'Esa dirección ya la usa otra clínica: elige otra.', cause: error });
        }
        throw error;
      }
    }),

  /** F27: QR code of the booking page (SVG and PNG, as data URLs) for the front desk. */
  bookingPageQr: adminProcedure.query(async ({ ctx }) => {
    const tenant = await ctx.repos.tenants.findById(ctx.tenantId);
    if (!tenant?.publicSlug) return null;
    const url = `${publicBaseUrl()}/reservar/${tenant.publicSlug}`;
    const options = { margin: 2, errorCorrectionLevel: 'M' as const };
    const [svg, png] = await Promise.all([QRCode.toString(url, { ...options, type: 'svg' }), QRCode.toDataURL(url, { ...options, width: 1024 })]);
    return { url, svg: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, png };
  }),

  /** Data protection settings (F12): privacy policy linked by the bot and retention period. */
  updatePrivacy: adminProcedure.input(privacyInput).mutation(async ({ ctx, input }) => {
    const tenant = await ctx.repos.tenants.update(ctx.tenantId, {
      settings: { privacyPolicyUrl: input.privacyPolicyUrl || null, retentionMonths: input.retentionMonths },
    });
    return toView(tenant);
  }),

  updateWhatsApp: adminProcedure.input(whatsappInput).mutation(async ({ ctx, input }) => {
    let phoneNormalized: string | null = null;
    if (input.phoneNormalized) {
      phoneNormalized = normalizePhone(input.phoneNormalized);
      if (!phoneNormalized) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Teléfono de WhatsApp no válido' });
    }
    const waPhoneNumberId = input.waPhoneNumberId || null;
    const current = await ctx.repos.tenants.findById(ctx.tenantId);
    const tokenChanged = typeof input.waAccessToken === 'string';
    // F32: a new number (or a new token for it) must be proven to be the clinic's (whatsapp-number.ts).
    if (waPhoneNumberId && (waPhoneNumberId !== (current?.waPhoneNumberId ?? null) || tokenChanged)) {
      const token = tokenChanged
        ? (input.waAccessToken as string)
        : current?.waAccessTokenEnc && input.waAccessToken !== null
          ? decryptSecret(current.waAccessTokenEnc, encryptionKey())
          : null;
      if (!token) {
        // With the platform's global token the clinic cannot prove anything: the platform assigns it.
        if (!isPlatformAdmin(verifiedEmail(ctx.user))) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Sin token propio, el número lo asigna el administrador de la plataforma. Si tienes tu propio token de Meta, añádelo.',
          });
        }
      } else {
        const check = await verifyWhatsAppNumber({ phoneNumberId: waPhoneNumberId, accessToken: token });
        if (!check.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: check.message });
        const metaPhone = check.displayPhone ? normalizePhone(check.displayPhone) : null;
        if (metaPhone && phoneNormalized && metaPhone !== phoneNormalized) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `En Meta ese número es el ${check.displayPhone}, no el número de WhatsApp del negocio que has escrito.`,
          });
        }
        phoneNormalized ??= metaPhone;
      }
    }
    try {
      const tenant = await ctx.repos.tenants.update(ctx.tenantId, {
        waPhoneNumberId,
        phoneNormalized,
        ...(input.waAccessToken === undefined
          ? {}
          : { waAccessTokenEnc: input.waAccessToken === null ? null : encryptSecret(input.waAccessToken, encryptionKey()) }),
      });
      return toView(tenant);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new TRPCError({ code: 'CONFLICT', message: 'Ese phone_number_id ya está asociado a otra clínica' });
      }
      throw error;
    }
  }),

  /** Current FAQ prompt (custom or default template filled with the tenant data). */
  getFaqPrompt: adminProcedure.query(async ({ ctx }) => {
    const tenant = await ctx.repos.tenants.findById(ctx.tenantId);
    if (!tenant) throw new TRPCError({ code: 'NOT_FOUND' });
    if (tenant.settings.faqPrompt?.trim()) return { content: tenant.settings.faqPrompt, isDefault: false };
    const [employees, services] = await Promise.all([
      ctx.repos.employees.list(ctx.tenantId),
      ctx.repos.services.list(ctx.tenantId, { activeOnly: true }),
    ]);
    return {
      content: buildDefaultFaqPrompt({
        clinicName: tenant.clinicName,
        phone: tenant.settings.contactPhone || tenant.phoneNormalized,
        sector: tenant.settings.sector,
        employees,
        info: tenant.settings.assistantInfo,
        services,
      }),
      isDefault: true,
    };
  }),

  /**
   * F29: the information of the assistant as stored (empty when never filled), and the lines
   * «Servicios y tratamientos» start with (the panel's services).
   */
  getAssistantInfo: adminProcedure.query(async ({ ctx }) => {
    const tenant = await ctx.repos.tenants.findById(ctx.tenantId);
    if (!tenant) throw new TRPCError({ code: 'NOT_FOUND' });
    const services = await ctx.repos.services.list(ctx.tenantId, { activeOnly: true });
    return {
      info: tenant.settings.assistantInfo ?? assistantInfoSchema.parse({}),
      suggestedServices: suggestedServiceLines(services),
      usesCustomPrompt: Boolean(tenant.settings.faqPrompt?.trim()),
    };
  }),

  /** F29: saves the information the FAQ prompt is generated from. */
  updateAssistantInfo: adminProcedure.input(assistantInfoSchema).mutation(async ({ ctx, input }) => {
    const tenant = await ctx.repos.tenants.update(ctx.tenantId, { settings: { assistantInfo: input } });
    return toView(tenant);
  }),

  /** RF-A4: stores the uploaded .txt (≤ 20 KB). `null` restores the default prompt. */
  uploadFaqPrompt: adminProcedure
    .input(
      z.object({
        content: z
          .string()
          .refine((v) => v.trim().length > 0, 'El fichero está vacío')
          .refine((v) => Buffer.byteLength(v, 'utf8') <= FAQ_PROMPT_MAX_BYTES, 'El fichero supera los 20 KB')
          .nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tenant = await ctx.repos.tenants.update(ctx.tenantId, {
        settings: { faqPrompt: input.content === null ? null : input.content.replace(/\r\n/g, '\n').trim() },
      });
      return toView(tenant);
    }),

  /** Creates the clinic of a user that has none yet (first login). */
  onboarding: authedProcedure
    .input(
      z.object({
        clinicName: z.string().trim().min(2, 'Mínimo 2 caracteres').max(80),
        contactPhone: z.string().trim().min(6, 'Indica un teléfono de contacto').max(30),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Creating a clinic is system work (F19): the user has no clinic context yet.
      const existing = await ctx.systemRepos.members.findByKindeUserId(ctx.user.id);
      if (existing) throw new TRPCError({ code: 'CONFLICT', message: 'Tu usuario ya tiene una clínica' });
      const tenant = await ctx.systemRepos.tenants.createWithOwner({
        clinicName: input.clinicName,
        contactPhone: input.contactPhone,
        kindeUserId: ctx.user.id,
        email: ctx.user.email,
        timezone: DEFAULT_TIMEZONE,
      });
      return toView(tenant);
    }),
});
