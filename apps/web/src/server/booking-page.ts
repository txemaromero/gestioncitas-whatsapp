/**
 * F27: data of the public booking page (`/reservar/<slug>`): no session, read-only. The clinic is
 * found by its address with the system connection; everything else is read inside its own
 * tenant context, like any other request of that clinic.
 */
import { cache } from 'react';
import { bookingPageDays, createRepos, getDatabase, runWithTenant, type Db, type Tenant } from '@clinicai/db';
import { formatHumanDate, formatTime, publicSlugSchema, webBookingMessage, whatsappLink } from '@clinicai/shared';

/** Address of the panel as users see it (the one Kinde redirects to). */
export function publicBaseUrl(): string {
  return (process.env.KINDE_SITE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
}

/** The clinic of a published page: enabled, with an address and a WhatsApp number. */
export const findPublishedClinic = cache(async (slug: string, system?: Db): Promise<(Tenant & { phoneNormalized: string }) | null> => {
  const parsed = publicSlugSchema.safeParse(slug);
  if (!parsed.success) return null;
  const tenant = await createRepos(system ?? getDatabase().system).tenants.findByPublicSlug(parsed.data);
  if (!tenant?.settings.bookingPageEnabled || !tenant.phoneNormalized) return null;
  return { ...tenant, phoneNormalized: tenant.phoneNormalized };
});

export interface BookingPageService {
  id: string;
  name: string;
  durationMinutes: number;
}

export interface BookingPageView {
  clinicName: string;
  contactPhone: string;
  privacyPolicyUrl: string | null;
  services: BookingPageService[];
  /** The chosen service, or the only one; null without services or before choosing one. */
  service: BookingPageService | null;
  /** Several services and none chosen yet: ask for one first. */
  chooseService: boolean;
  days: { dayKey: string; label: string; count: number }[];
  /** The chosen day (or the first with free slots) and its slots. */
  day: { dayKey: string; label: string; slots: { time: string; label: string; href: string }[] } | null;
}

const shortDay = (date: Date, timeZone: string) =>
  new Intl.DateTimeFormat('es-ES', { timeZone, weekday: 'short', day: 'numeric', month: 'short' }).format(date);

export async function loadBookingPage(
  slug: string,
  query: { servicio?: string; dia?: string },
  options: { db?: { system: Db; app: Db }; now?: Date } = {},
): Promise<BookingPageView | null> {
  const db = options.db ?? getDatabase();
  const now = options.now ?? new Date();
  const tenant = await findPublishedClinic(slug, db.system);
  if (!tenant) return null;
  const app = db.app;
  return runWithTenant(tenant.id, async () => {
    const services = (await createRepos(app).services.list(tenant.id, { activeOnly: true })).map((s) => ({
      id: s.id,
      name: s.name,
      durationMinutes: s.durationMinutes,
    }));
    const service = (services.length === 1 ? services[0] : services.find((s) => s.id === query.servicio)) ?? null;
    const chooseService = services.length > 1 && !service;
    const timeZone = tenant.timezone;
    const days = chooseService
      ? []
      : await bookingPageDays(app, tenant.id, {
          durationMinutes: service?.durationMinutes ?? tenant.settings.slotMinutes,
          slotMinutes: tenant.settings.slotMinutes,
          timeZone,
          now,
        });
    const selected = days.find((d) => d.dayKey === query.dia) ?? days[0] ?? null;
    return {
      clinicName: tenant.clinicName,
      contactPhone: tenant.settings.contactPhone,
      privacyPolicyUrl: tenant.settings.privacyPolicyUrl,
      services,
      service,
      chooseService,
      days: days.map((d) => ({ dayKey: d.dayKey, label: shortDay(d.slots[0]!, timeZone), count: d.slots.length })),
      day: selected
        ? {
            dayKey: selected.dayKey,
            label: formatHumanDate(selected.slots[0]!, timeZone),
            slots: selected.slots.map((start) => {
              const time = formatTime(start, timeZone);
              const message = webBookingMessage({ serviceName: service?.name ?? null, start, timeZone, serviceId: service?.id ?? null });
              return {
                time,
                label: `Pedir cita el ${formatHumanDate(start, timeZone)} a las ${time} por WhatsApp (se abre en otra pestaña)`,
                href: whatsappLink(tenant.phoneNormalized, message),
              };
            }),
          }
        : null,
    };
  });
}
