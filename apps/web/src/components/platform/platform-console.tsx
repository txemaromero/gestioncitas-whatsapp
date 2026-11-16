import { AlertTriangleIcon, ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import Link from 'next/link';
import { Logo } from '@/components/layout/logo';
import { Badge, Card, CardContent, TBody, TD, TH, THead, TR } from '@/components/ui/misc';
import type { PlatformClinicRow, PlatformConsole } from '@/server/platform';

const int = new Intl.NumberFormat('es-ES');
const compact = new Intl.NumberFormat('es-ES', { notation: 'compact', maximumFractionDigits: 1 });
const usd = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (value: number) => (value > 0 && value < 0.01 ? `< ${usd.format(0.01)}` : usd.format(value));
const day = (date: Date) => new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date);

function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y ?? 2000, (m ?? 1) - 1, 1)));
}

const tokens = (usage: PlatformClinicRow['usage']) =>
  Object.values(usage.llm).reduce((sum, u) => sum + u.promptTokens + u.completionTokens, 0);
const requests = (usage: PlatformClinicRow['usage']) => Object.values(usage.llm).reduce((sum, u) => sum + u.requests, 0);
const voiceMinutes = (usage: PlatformClinicRow['usage']) =>
  Math.ceil(Object.values(usage.transcription).reduce((sum, s) => sum + s, 0) / 60);

function StatTile({ label, value, sub }: { label: string; value: string; sub?: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="grid gap-1 pt-5">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
        {sub ? <p className="text-xs text-muted-foreground">{sub}</p> : null}
      </CardContent>
    </Card>
  );
}

const WHATSAPP_LABELS: Record<PlatformClinicRow['whatsapp'], { text: string; variant: 'confirmed' | 'muted' | 'outline' }> = {
  own: { text: 'Número y token propios', variant: 'confirmed' },
  number: { text: 'Número propio', variant: 'outline' },
  none: { text: 'Sin configurar', variant: 'muted' },
};

export function PlatformConsoleView({ data }: { data: PlatformConsole }) {
  const { month, totals, clinics } = data;
  const { usage } = totals;
  return (
    <div className="min-h-dvh bg-muted/30">
      <header className="border-b bg-background">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4 sm:px-6">
          <Logo href="/dashboard" />
          <span className="text-sm text-muted-foreground">Plataforma</span>
          <Link href="/dashboard" className="ml-auto text-sm font-medium text-primary underline-offset-4 hover:underline">
            Volver al panel
          </Link>
        </div>
      </header>
      <main className="mx-auto grid w-full max-w-7xl gap-6 px-4 py-6 sm:px-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Consola de la plataforma</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Cifras de todas las clínicas. Solo lectura y sin datos de sus clientes.
            </p>
          </div>
          <nav aria-label="Mes" className="flex items-center gap-2 text-sm">
            <Link
              href={`/plataforma?mes=${month.previous}`}
              className="inline-flex items-center gap-1 rounded-md border bg-background px-2.5 py-1.5 hover:bg-accent"
            >
              <ChevronLeftIcon className="size-4" aria-hidden />
              <span className="first-letter:uppercase">{monthLabel(month.previous)}</span>
            </Link>
            <span className="px-2 font-semibold first-letter:uppercase" aria-current="page">
              {monthLabel(month.key)}
            </span>
            {month.next ? (
              <Link
                href={`/plataforma?mes=${month.next}`}
                className="inline-flex items-center gap-1 rounded-md border bg-background px-2.5 py-1.5 hover:bg-accent"
              >
                <span className="first-letter:uppercase">{monthLabel(month.next)}</span>
                <ChevronRightIcon className="size-4" aria-hidden />
              </Link>
            ) : null}
          </nav>
        </div>

        {data.pricesError ? (
          <p role="alert" className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
            <AlertTriangleIcon className="size-4 shrink-0" aria-hidden />
            {data.pricesError}. Se usan los precios por defecto.
          </p>
        ) : null}

        <section aria-label="Resumen del mes" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatTile label="Clínicas" value={int.format(totals.clinics)} sub={`${int.format(totals.active)} con actividad este mes`} />
          <StatTile
            label="Mensajes recibidos"
            value={int.format(usage.inbound)}
            sub={`Enviados: ${int.format(usage.outbound)} respuestas y ${int.format(usage.templates)} plantillas`}
          />
          <StatTile
            label="Citas reservadas"
            value={int.format(totals.appointments.whatsapp + totals.appointments.web)}
            sub={`${int.format(totals.appointments.whatsapp)} por WhatsApp y ${int.format(totals.appointments.web)} desde el panel`}
          />
          <StatTile
            label="Peticiones de IA"
            value={int.format(requests(usage))}
            sub={`${compact.format(tokens(usage))} tokens · ${int.format(voiceMinutes(usage))} min de notas de voz`}
          />
          <StatTile
            label="Coste estimado de IA"
            value={money(totals.cost.ai)}
            sub={totals.unpriced.length > 0 ? `Sin precio: ${totals.unpriced.join(', ')}` : 'Modelos de lenguaje y transcripción'}
          />
          <StatTile
            label="Coste estimado de WhatsApp"
            value={money(totals.cost.whatsapp)}
            sub={`Plantillas y respuestas por encima de ${int.format(data.prices.whatsapp.serviceFreePerMonth)} al mes`}
          />
        </section>

        <section aria-labelledby="clinics-title" className="grid gap-3">
          <h2 id="clinics-title" className="text-lg font-semibold">
            Clínicas
          </h2>
          {clinics.length === 0 ? (
            <p className="text-sm text-muted-foreground">Todavía no hay clínicas.</p>
          ) : (
            // Focusable so the table can be scrolled sideways with the keyboard.
            <div tabIndex={0} role="region" aria-labelledby="clinics-title" className="relative w-full overflow-x-auto rounded-xl border bg-background focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
              <table className="w-full text-sm">
                <THead>
                  <TR>
                    <TH scope="col">Clínica</TH>
                    <TH scope="col" className="text-right">Equipo</TH>
                    <TH scope="col" className="text-right">Clientes</TH>
                    <TH scope="col">WhatsApp</TH>
                    <TH scope="col">Reservas web</TH>
                    <TH scope="col" className="text-right">Citas del mes</TH>
                    <TH scope="col" className="text-right">Mensajes</TH>
                    <TH scope="col" className="text-right">IA</TH>
                    <TH scope="col" className="text-right">Coste estimado</TH>
                    <TH scope="col">Último mensaje</TH>
                    <TH scope="col">Fallos 24 h</TH>
                  </TR>
                </THead>
                <TBody>
                  {clinics.map((c) => (
                    <TR key={c.id}>
                      <TD>
                        <p className="font-medium">{c.clinicName}</p>
                        <p className="text-xs text-muted-foreground">
                          Alta: {day(c.createdAt)}
                          {c.ownerEmail ? ` · ${c.ownerEmail}` : ''}
                        </p>
                      </TD>
                      <TD className="text-right tabular-nums">{int.format(c.members)}</TD>
                      <TD className="text-right tabular-nums">{int.format(c.clients)}</TD>
                      <TD>
                        <Badge variant={WHATSAPP_LABELS[c.whatsapp].variant}>{WHATSAPP_LABELS[c.whatsapp].text}</Badge>
                      </TD>
                      <TD>{c.bookingPage ? 'Publicada' : 'No'}</TD>
                      <TD className="text-right tabular-nums">
                        {int.format(c.appointments.whatsapp + c.appointments.web)}
                        <p className="text-xs text-muted-foreground">
                          {int.format(c.appointments.whatsapp)} WhatsApp · {int.format(c.appointments.web)} panel
                        </p>
                      </TD>
                      <TD className="text-right tabular-nums">
                        {int.format(c.usage.inbound)} recibidos
                        <p className="text-xs text-muted-foreground">
                          {int.format(c.usage.outbound)} respuestas · {int.format(c.usage.templates)} plantillas
                        </p>
                      </TD>
                      <TD className="text-right tabular-nums">
                        {int.format(requests(c.usage))} peticiones
                        <p className="text-xs text-muted-foreground">
                          {compact.format(tokens(c.usage))} tokens
                          {voiceMinutes(c.usage) > 0 ? ` · ${int.format(voiceMinutes(c.usage))} min voz` : ''}
                        </p>
                      </TD>
                      <TD className="text-right tabular-nums">
                        {money(c.cost.ai + c.cost.whatsapp)}
                        <p className="text-xs text-muted-foreground">
                          IA {money(c.cost.ai)} · WhatsApp {money(c.cost.whatsapp)}
                        </p>
                      </TD>
                      <TD className="whitespace-nowrap">{c.lastInboundDay ? day(c.lastInboundDay) : 'Nunca'}</TD>
                      <TD>
                        {c.failedEvents24h > 0 ? (
                          <Badge variant="cancelled">
                            <AlertTriangleIcon className="mr-1 size-3" aria-hidden />
                            {int.format(c.failedEvents24h)} fallidos
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">Ninguno</span>
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </table>
            </div>
          )}
        </section>

        <p className="text-xs text-muted-foreground">
          Los contadores empezaron con esta consola: los meses anteriores no tienen datos de uso. Costes estimados en dólares
          (USD) con los precios de lista de OpenAI y de Meta para España (plantillas como «utilidad»; las primeras{' '}
          {int.format(data.prices.whatsapp.serviceFreePerMonth)} respuestas al mes de cada número son gratis). No es la
          factura: cámbialos con la variable PLATFORM_PRICES. Días en hora UTC.
        </p>
      </main>
    </div>
  );
}
