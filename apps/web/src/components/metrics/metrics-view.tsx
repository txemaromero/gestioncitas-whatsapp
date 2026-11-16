'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowDownIcon, ArrowUpIcon, ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { formatDuration, shiftMonthKey, toZonedDateKey } from '@clinicai/shared';
import { useTenant } from '@/components/layout/tenant-context';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader, Skeleton } from '@/components/ui/misc';
import type { RouterOutputs } from '@/server/routers/_app';
import { useTRPC } from '@/trpc/react';

type Metrics = RouterOutputs['metrics']['month'];
type TrendPoint = Metrics['trend'][number];

const percent = new Intl.NumberFormat('es-ES', { style: 'percent', maximumFractionDigits: 0 });
const pct = (value: number | null) => (value === null ? '—' : percent.format(value));

function monthLabel(month: string, style: 'long' | 'short' = 'long'): string {
  const [y, m] = month.split('-').map(Number);
  const date = new Date(Date.UTC(y ?? 2000, (m ?? 1) - 1, 1));
  return new Intl.DateTimeFormat('es-ES', style === 'long' ? { month: 'long', year: 'numeric', timeZone: 'UTC' } : { month: 'short', timeZone: 'UTC' }).format(date);
}

/** Stat tile: label · value · supporting line · optional delta. */
function StatTile({ label, value, sub, delta }: { label: string; value: string; sub?: React.ReactNode; delta?: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="grid gap-1 pt-6">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="text-3xl font-semibold">{value}</p>
        {delta}
        {sub ? <p className="text-xs text-muted-foreground">{sub}</p> : null}
      </CardContent>
    </Card>
  );
}

/** No-show rate change vs the previous month: up is bad (red), down is good (green); icon + text. */
function RateDelta({ current, previous, previousMonth }: { current: number | null; previous: number | null; previousMonth: string }) {
  if (current === null || previous === null) return null;
  const points = Math.round((current - previous) * 100);
  if (points === 0) return <p className="text-xs text-muted-foreground">Igual que en {monthLabel(previousMonth)}</p>;
  const up = points > 0;
  const Icon = up ? ArrowUpIcon : ArrowDownIcon;
  return (
    <p className={`flex items-center gap-1 text-xs font-medium ${up ? 'text-red-700' : 'text-emerald-700'}`}>
      <Icon className="size-3" aria-hidden />
      {up ? '+' : '−'}
      {Math.abs(points)} puntos frente a {monthLabel(previousMonth)}
    </p>
  );
}

/** Meter list: one row per professional, occupancy = booked / scheduled minutes. */
function OccupancyList({ employees }: { employees: Metrics['employees'] }) {
  if (employees.length === 0) return <p className="text-sm text-muted-foreground">No hay profesionales.</p>;
  return (
    <ul className="grid gap-4" aria-label="Ocupación por profesional">
      {employees.map((e) => (
        <li key={e.id} className="grid gap-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="flex items-center gap-2 text-sm font-medium">
              {e.name}
              {e.active ? null : <Badge variant="muted">Inactivo</Badge>}
            </span>
            <span className="text-sm font-semibold tabular-nums">{e.occupancy === null ? 'Sin horario' : pct(e.occupancy)}</span>
          </div>
          {e.occupancy === null ? null : (
            <div
              className="h-2 overflow-hidden rounded-full bg-primary/15"
              role="meter"
              aria-label={`Ocupación de ${e.name}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(e.occupancy * 100)}
            >
              <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(1, e.occupancy) * 100}%` }} />
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {e.appointments === 1 ? '1 cita' : `${e.appointments} citas`} · {formatDuration(e.bookedMinutes)} reservadas
            {e.scheduledMinutes > 0 ? ` de ${formatDuration(e.scheduledMinutes)} de agenda` : ''}
            {e.noShow > 0 ? ` · ${e.noShow} no se presentó` : ''}
          </p>
        </li>
      ))}
    </ul>
  );
}

/** Ranked horizontal bars, one hue, largest first. */
function ServiceBars({ services }: { services: Metrics['services'] }) {
  if (services.length === 0) return <p className="text-sm text-muted-foreground">No hay citas en este mes.</p>;
  const max = Math.max(...services.map((s) => s.appointments));
  return (
    <ul className="grid gap-3" aria-label="Citas por servicio">
      {services.map((s) => (
        <li key={s.id ?? 'none'} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3 text-sm">
          <span className="truncate">{s.name}</span>
          <span className="h-3 rounded-r-[4px] bg-primary" style={{ width: `${(s.appointments / max) * 100}%` }} />
          <span className="font-semibold tabular-nums">{s.appointments}</span>
        </li>
      ))}
    </ul>
  );
}

/** Line chart of the no-show rate per month (single series), crosshair + tooltip on hover/focus. */
function NoShowTrend({ points }: { points: TrendPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  // Drawn at the real width (no scaling): 2px line and 11px labels at any size.
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(Math.round(w));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const rates = points.map((p) => p.noShowRate);
  if (rates.every((r) => r === null)) {
    return <p className="text-sm text-muted-foreground">Todavía no hay citas marcadas en estos meses.</p>;
  }
  const W = width;
  const H = 200;
  const pad = { left: 44, right: 16, top: 16, bottom: 30 };
  const yMax = Math.max(0.2, Math.ceil(Math.max(...rates.map((r) => r ?? 0)) * 10) / 10);
  const x = (i: number) => pad.left + (i * (W - pad.left - pad.right)) / Math.max(1, points.length - 1);
  const y = (r: number) => pad.top + (1 - r / yMax) * (H - pad.top - pad.bottom);
  const ticks = [0, yMax / 2, yMax];
  // Path with gaps where a month has no marked appointments.
  let d = '';
  rates.forEach((r, i) => {
    if (r === null) return;
    d += `${i > 0 && rates[i - 1] !== null ? 'L' : 'M'}${x(i)},${y(r)} `;
  });
  const band = (W - pad.left - pad.right) / Math.max(1, points.length - 1);
  const active = hover === null ? null : points[hover];
  // Keep the tooltip inside the card near the edges.
  const tooltipShift = hover === null ? '-50%' : x(hover) < 110 ? '0%' : x(hover) > W - 110 ? '-100%' : '-50%';

  return (
    <div className="relative" ref={container}>
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        className="block w-full"
        role="img"
        aria-label={`Tasa de no presentados por mes: ${points.map((p) => `${monthLabel(p.month)} ${pct(p.noShowRate)}`).join(', ')}`}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={W - pad.right} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} />
            <text x={pad.left - 8} y={y(t)} textAnchor="end" dominantBaseline="middle" className="fill-muted-foreground text-[11px] tabular-nums">
              {percent.format(t)}
            </text>
          </g>
        ))}
        {points.map((p, i) => (
          <text key={p.month} x={x(i)} y={H - 8} textAnchor="middle" className="fill-muted-foreground text-[11px]">
            {monthLabel(p.month, 'short')}
          </text>
        ))}
        {hover !== null ? (
          <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={H - pad.bottom} stroke="var(--muted-foreground)" strokeOpacity={0.5} strokeWidth={1} />
        ) : null}
        <path d={d} fill="none" stroke="var(--primary)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {rates.map((r, i) =>
          r === null ? null : (
            <circle key={points[i]!.month} cx={x(i)} cy={y(r)} r={hover === i ? 5 : 4} fill="var(--primary)" stroke="var(--card)" strokeWidth={2} />
          ),
        )}
        {points.map((p, i) => (
          <rect
            key={`hit-${p.month}`}
            x={x(i) - band / 2}
            y={pad.top}
            width={band}
            height={H - pad.top - pad.bottom}
            fill="transparent"
            tabIndex={0}
            aria-label={`${monthLabel(p.month)}: ${pct(p.noShowRate)} de no presentados`}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
          />
        ))}
      </svg>
      {active && hover !== null ? (
        <div
          className="pointer-events-none absolute top-0 z-10 w-max rounded-md border bg-card px-3 py-2 text-xs shadow-md"
          style={{ left: x(hover), transform: `translateX(${tooltipShift})` }}
        >
          <p className="font-semibold first-letter:uppercase">{monthLabel(active.month)}</p>
          <p>
            No presentados: <span className="font-semibold">{pct(active.noShowRate)}</span>
          </p>
          <p className="text-muted-foreground">
            {active.noShow} de {active.attended + active.noShow} marcadas · {active.unmarked} sin marcar
          </p>
        </div>
      ) : null}
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-muted-foreground">Ver los datos en tabla</summary>
        <table className="mt-2 w-full text-left text-xs tabular-nums">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1 font-medium">Mes</th>
              <th className="py-1 font-medium">Citas</th>
              <th className="py-1 font-medium">Asistieron</th>
              <th className="py-1 font-medium">No se presentaron</th>
              <th className="py-1 font-medium">Sin marcar</th>
              <th className="py-1 font-medium">Tasa</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.month} className="border-t">
                <td className="py-1 first-letter:uppercase">{monthLabel(p.month)}</td>
                <td className="py-1">{p.active}</td>
                <td className="py-1">{p.attended}</td>
                <td className="py-1">{p.noShow}</td>
                <td className="py-1">{p.unmarked}</td>
                <td className="py-1">{pct(p.noShowRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

/** F15: monthly figures of the clinic. */
export function MetricsView() {
  const trpc = useTRPC();
  const tenant = useTenant();
  const [current] = useState(() => toZonedDateKey(new Date(), tenant.timezone).slice(0, 7));
  const [month, setMonth] = useState(current);
  const metrics = useQuery({ ...trpc.metrics.month.queryOptions({ month }), placeholderData: keepPreviousData });
  const m = metrics.data;
  const previous = m?.trend.at(-2);

  return (
    <>
      <PageHeader
        title="Métricas"
        description="Asistencia, ocupación y reservas de la clínica, mes a mes."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" aria-label="Mes anterior" onClick={() => setMonth((v) => shiftMonthKey(v, -1) ?? v)}>
              <ChevronLeftIcon />
            </Button>
            <span className="min-w-36 text-center text-sm font-semibold first-letter:uppercase" aria-live="polite">
              {monthLabel(month)}
            </span>
            <Button variant="outline" size="icon" aria-label="Mes siguiente" onClick={() => setMonth((v) => shiftMonthKey(v, 1) ?? v)}>
              <ChevronRightIcon />
            </Button>
            {month !== current ? (
              <Button variant="ghost" size="sm" onClick={() => setMonth(current)}>
                Mes actual
              </Button>
            ) : null}
          </div>
        }
      />
      {!m ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : (
        <div className="grid gap-6">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5" aria-label="Resumen del mes">
            <StatTile label="Citas" value={String(m.active)} sub={`${m.past} ya pasadas · ${m.future} por venir`} />
            <StatTile
              label="No se presentaron"
              value={pct(m.noShowRate)}
              delta={previous ? <RateDelta current={m.noShowRate} previous={previous.noShowRate} previousMonth={previous.month} /> : null}
              sub={m.attended + m.noShow > 0 ? `${m.noShow} de ${m.attended + m.noShow} citas marcadas` : 'Ninguna cita marcada todavía'}
            />
            <StatTile
              label="Sin marcar"
              value={String(m.unmarked)}
              sub={
                m.unmarked > 0 ? (
                  <>
                    No cuentan en la tasa.{' '}
                    <Link href="/dashboard" className="font-medium text-primary hover:underline">
                      Marcar en Inicio
                    </Link>
                  </>
                ) : (
                  'Todas las citas pasadas están marcadas'
                )
              }
            />
            <StatTile label="Cancelaciones" value={pct(m.cancellationRate)} sub={`${m.cancelled} de ${m.total} citas`} />
            <StatTile
              label="Reservadas por WhatsApp"
              value={pct(m.active > 0 ? m.channels.whatsapp / m.active : null)}
              sub={`${m.channels.whatsapp} por WhatsApp · ${m.channels.web} desde el panel`}
            />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Ocupación por profesional</CardTitle>
                <CardDescription>Tiempo reservado sobre su horario del mes, descontando ausencias y cierres.</CardDescription>
              </CardHeader>
              <CardContent>
                <OccupancyList employees={m.employees} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Citas por servicio</CardTitle>
                <CardDescription>Citas no canceladas del mes.</CardDescription>
              </CardHeader>
              <CardContent>
                <ServiceBars services={m.services} />
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>No presentados en los últimos 6 meses</CardTitle>
              <CardDescription>Porcentaje de citas marcadas en las que el cliente no se presentó.</CardDescription>
            </CardHeader>
            <CardContent>
              <NoShowTrend points={m.trend} />
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}
