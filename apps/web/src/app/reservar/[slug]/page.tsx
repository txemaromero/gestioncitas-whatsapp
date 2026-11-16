import { CalendarDaysIcon, MessageCircleIcon, PhoneIcon } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { formatDuration } from '@clinicai/shared';
import { cn } from '@/lib/utils';
import { findPublishedClinic, loadBookingPage } from '@/server/booking-page';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const clinic = await findPublishedClinic((await params).slug);
  if (!clinic) return { title: 'Página no encontrada' };
  return {
    title: `Pedir cita en ${clinic.clinicName}`,
    description: `Elige un hueco libre en ${clinic.clinicName} y confirma tu cita por WhatsApp.`,
  };
}

const chip = (selected: boolean) =>
  cn(
    'flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50',
    selected ? 'border-primary bg-primary text-primary-foreground' : 'bg-background hover:bg-muted',
  );

/** F27: public booking page of a clinic. Choosing a time opens WhatsApp with the request written. */
export default async function BookingPage({ params, searchParams }: Props) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const servicio = first(query.servicio);
  const page = await loadBookingPage(slug, { ...(servicio ? { servicio } : {}), ...(first(query.dia) ? { dia: first(query.dia)! } : {}) });
  if (!page) notFound();
  const withService = (extra: Record<string, string>) =>
    `?${new URLSearchParams({ ...(page.service && page.services.length > 1 ? { servicio: page.service.id } : {}), ...extra }).toString()}`;
  const step = (n: number) => (page.services.length > 1 ? `${n}. ` : '');

  return (
    <main className="mx-auto grid min-h-dvh w-full max-w-2xl content-start gap-8 px-4 py-10">
      <header className="grid gap-2">
        <p className="flex items-center gap-2 text-sm font-medium text-primary">
          <CalendarDaysIcon className="size-4" aria-hidden="true" /> Reserva tu cita
        </p>
        <h1 className="text-3xl font-bold tracking-tight">{page.clinicName}</h1>
        <p className="text-muted-foreground">
          Elige un hueco libre y se abrirá WhatsApp con tu cita ya escrita: solo tienes que enviar el mensaje y nuestro asistente la confirma
          contigo.
        </p>
      </header>

      {page.services.length > 1 ? (
        <section className="grid gap-3" aria-labelledby="booking-services">
          <h2 id="booking-services" className="text-lg font-semibold">
            {step(1)}Elige el servicio
          </h2>
          <ul className="grid gap-2 sm:grid-cols-2">
            {page.services.map((s) => {
              const selected = page.service?.id === s.id;
              return (
                <li key={s.id}>
                  <Link href={`?${new URLSearchParams({ servicio: s.id }).toString()}`} aria-current={selected ? 'true' : undefined} className={chip(selected)}>
                    <span>{s.name}</span>
                    <span className={cn('text-xs font-normal', selected ? 'text-primary-foreground' : 'text-muted-foreground')}>
                      {formatDuration(s.durationMinutes)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {!page.chooseService ? (
        <section className="grid gap-3" aria-labelledby="booking-days">
          <h2 id="booking-days" className="text-lg font-semibold">
            {step(2)}Elige el día
          </h2>
          {page.days.length === 0 ? (
            <p className="rounded-lg border bg-muted/50 p-4 text-sm">
              No quedan huecos libres en los próximos 14 días.
              {page.contactPhone ? ` Llámanos al ${page.contactPhone} y te buscamos uno.` : ''}
            </p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {page.days.map((d) => {
                const selected = page.day?.dayKey === d.dayKey;
                return (
                  <li key={d.dayKey}>
                    <Link href={withService({ dia: d.dayKey })} aria-current={selected ? 'date' : undefined} className={chip(selected)}>
                      <span className="first-letter:uppercase">{d.label}</span>
                      <span className="sr-only">, {d.count === 1 ? '1 hueco libre' : `${d.count} huecos libres`}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : null}

      {page.day ? (
        <section className="grid gap-3" aria-labelledby="booking-times">
          <h2 id="booking-times" className="text-lg font-semibold first-letter:uppercase">
            {step(3)}
            {page.day.label}
          </h2>
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            {page.day.slots.map((s) => (
              <li key={s.time}>
                <a href={s.href} target="_blank" rel="noopener noreferrer" aria-label={s.label} className={cn(chip(false), 'justify-center tabular-nums')}>
                  {s.time}
                </a>
              </li>
            ))}
          </ul>
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <MessageCircleIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            Se abrirá WhatsApp con el mensaje escrito. Si el hueco se ocupa mientras tanto, el asistente te ofrecerá los más cercanos.
          </p>
        </section>
      ) : null}

      <footer className="grid gap-2 border-t pt-6 text-sm text-muted-foreground">
        {page.contactPhone ? (
          <p className="flex items-center gap-2">
            <PhoneIcon className="size-4" aria-hidden="true" /> {page.clinicName}: {page.contactPhone}
          </p>
        ) : null}
        <p>
          Esta página no guarda ningún dato. Al escribirnos por WhatsApp, el asistente te pedirá aceptar el aviso de privacidad antes de
          registrar nada.
          {page.privacyPolicyUrl ? (
            <>
              {' '}
              <a href={page.privacyPolicyUrl} className="underline underline-offset-2" rel="noopener noreferrer" target="_blank">
                Política de privacidad
              </a>
              .
            </>
          ) : null}
        </p>
        <p className="text-xs">Reservas con ClinicAI</p>
      </footer>
    </main>
  );
}
