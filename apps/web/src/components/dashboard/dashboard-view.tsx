'use client';

import { useQuery } from '@tanstack/react-query';
import { CalendarClockIcon, CalendarDaysIcon, CheckCircle2Icon, ClockIcon } from 'lucide-react';
import Link from 'next/link';
import { employeeColor, formatEsShort, formatHumanDate, formatTime, isAdminRole } from '@clinicai/shared';
import { AttendanceButtons } from '@/components/attendance/attendance-buttons';
import { useTenant } from '@/components/layout/tenant-context';
import { WaitlistCard } from '@/components/waitlist/waitlist-card';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton, StatusBadge } from '@/components/ui/misc';
import { useTRPC } from '@/trpc/react';
import { REFRESH_MS } from '@/lib/utils';

export function DashboardView() {
  const trpc = useTRPC();
  const tenant = useTenant();
  const today = useQuery({ ...trpc.appointments.today.queryOptions(), refetchInterval: REFRESH_MS });
  // F15: past appointments of the last two weeks still without attendance.
  const unmarked = useQuery({ ...trpc.appointments.unmarked.queryOptions({ days: 14 }), refetchInterval: REFRESH_MS });

  return (
    <div className="grid gap-6">
      <div>
        <p className="text-sm text-muted-foreground">{formatHumanDate(new Date(), tenant.timezone)}</p>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">{tenant.clinicName}</h1>
        {tenant.employeeName ? (
          <p className="mt-1 text-sm text-muted-foreground">Tu agenda: {tenant.employeeName}</p>
        ) : null}
      </div>

      <Link
        href="/calendar"
        className="group flex flex-col gap-4 rounded-2xl bg-foreground p-6 text-background shadow-sm transition-transform hover:-translate-y-0.5 sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="flex items-center gap-4">
          <span className="grid size-12 place-items-center rounded-xl bg-primary">
            <CalendarDaysIcon className="size-6 text-primary-foreground" />
          </span>
          <div>
            <p className="text-lg font-semibold">Abrir calendario</p>
            <p className="text-sm text-background/70">
              {tenant.employeeId ? 'Consulta, crea y edita tus citas.' : 'Consulta, crea y edita las citas de la clínica.'}
            </p>
          </div>
        </div>
        <span className={buttonVariants({ className: 'w-full sm:w-auto' })}>Ir al calendario</span>
      </Link>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardDescription>Citas de hoy</CardDescription>
            <ClockIcon className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {today.isLoading ? <Skeleton className="h-9 w-16" /> : <p className="text-3xl font-bold">{today.data?.total ?? 0}</p>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardDescription>Pendientes de confirmar</CardDescription>
            <CalendarClockIcon className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {today.isLoading ? (
              <Skeleton className="h-9 w-16" />
            ) : (
              <p className="text-3xl font-bold text-amber-600">{today.data?.pendingUpcoming ?? 0}</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Agenda de hoy</CardTitle>
        </CardHeader>
        <CardContent>
          {today.isLoading ? (
            <Skeleton className="h-20" />
          ) : (today.data?.list ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No hay citas para hoy.</p>
          ) : (
            <ul className="divide-y">
              {(today.data?.list ?? []).map((a) => (
                <li key={a.id} className="flex items-center gap-3 py-3">
                  <span className="w-12 text-sm font-semibold tabular-nums">{formatTime(a.date, tenant.timezone)}</span>
                  <span className="size-2.5 rounded-full" style={{ backgroundColor: employeeColor(a.employeeId) }} />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {a.client.name} con {a.employee.name}
                  </span>
                  <StatusBadge status={a.status} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Asistencia por marcar</CardTitle>
          <CardDescription>
            Citas de las dos últimas semanas que ya han pasado. Marcar quién vino y quién no alimenta las{' '}
            <Link href="/metrics" className="font-medium text-primary hover:underline">
              métricas
            </Link>
            .
          </CardDescription>
        </CardHeader>
        <CardContent>
          {unmarked.isLoading ? (
            <Skeleton className="h-20" />
          ) : (unmarked.data ?? []).length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <CheckCircle2Icon className="size-4 text-emerald-600" /> Todo al día: no queda ninguna cita por marcar.
            </p>
          ) : (
            <ul className="divide-y" aria-label="Citas por marcar">
              {(unmarked.data ?? []).map((a) => {
                const label = `${a.client.name} con ${a.employee.name}, ${formatEsShort(a.date, tenant.timezone)}`;
                return (
                  <li key={a.id} className="flex flex-wrap items-center gap-3 py-3">
                    <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: employeeColor(a.employeeId) }} />
                    <span className="min-w-48 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {a.client.name} con {a.employee.name}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {formatEsShort(a.date, tenant.timezone)}
                        {a.service ? ` · ${a.service.name}` : ''}
                      </span>
                    </span>
                    <AttendanceButtons appointmentId={a.id} attendance={null} label={label} />
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {isAdminRole(tenant.role) ? <WaitlistCard /> : null}
    </div>
  );
}
