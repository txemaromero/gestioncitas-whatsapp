'use client';

import type { EventInput } from '@fullcalendar/react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { PlusIcon, SmartphoneIcon } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useCallback, useMemo, useState } from 'react';
import {
  addMinutes,
  employeeColor,
  formatHumanDateTime,
  formatTime,
  isWholeLocalDays,
  toDateTimeLocalValue,
  toZonedDateKey,
  zonedTimeToUtc,
  getZonedParts,
} from '@clinicai/shared';
import { useTenant } from '@/components/layout/tenant-context';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, PageHeader, Skeleton, StatusBadge } from '@/components/ui/misc';
import { calendarDateToInstant } from '@/lib/dates';
import { REFRESH_MS } from '@/lib/utils';
import { useTRPC } from '@/trpc/react';
import { AgendaLinkDialog } from './agenda-link-dialog';
import { AppointmentDialog, type AppointmentDialogState, type AppointmentItem } from './appointment-dialog';

const CalendarCanvas = dynamic(() => import('./full-calendar'), {
  ssr: false,
  loading: () => <Skeleton className="h-[640px] w-full" />,
});

export function CalendarView() {
  const trpc = useTRPC();
  const tenant = useTenant();
  const tz = tenant.timezone;
  const [range, setRange] = useState<{ from: Date; to: Date } | null>(null);
  const [dialog, setDialog] = useState<AppointmentDialogState>({ open: false });
  const [agendaOpen, setAgendaOpen] = useState(false);
  // Cancelled appointments are hidden unless asked: they used to squeeze the new booking of the same time.
  const [showCancelled, setShowCancelled] = useState(false);

  const list = useQuery({
    ...trpc.appointments.list.queryOptions(range ?? { from: new Date(0), to: new Date(1) }),
    enabled: range !== null,
    refetchInterval: REFRESH_MS,
    refetchOnWindowFocus: true,
    placeholderData: keepPreviousData,
  });
  // F14: absences and clinic closures in the visible range.
  const timeOff = useQuery({
    ...trpc.timeOff.list.queryOptions(range ?? { from: new Date(0), to: new Date(1) }),
    enabled: range !== null,
    refetchInterval: REFRESH_MS,
    refetchOnWindowFocus: true,
    placeholderData: keepPreviousData,
  });
  const upcoming = useQuery({
    ...trpc.appointments.upcoming.queryOptions({ limit: 15 }),
    refetchInterval: REFRESH_MS,
    refetchOnWindowFocus: true,
  });

  const cancelledCount = useMemo(() => (list.data ?? []).filter((a) => a.status === 'cancelled').length, [list.data]);
  // «Próximas citas» follows the same «Ver canceladas» choice as the calendar.
  const upcomingShown = useMemo(
    () => (upcoming.data ?? []).filter((a) => showCancelled || a.status !== 'cancelled'),
    [upcoming.data, showCancelled],
  );
  const events = useMemo<EventInput[]>(
    () =>
      (list.data ?? [])
        .filter((a) => showCancelled || a.status !== 'cancelled')
        .map((a) => ({
        id: a.id,
        // F15: ✓ attended / ✗ no-show in front of the time.
        title: `${a.attendance === 'attended' ? '✓ ' : a.attendance === 'no_show' ? '✗ ' : ''}${formatTime(a.date, tz)} ${a.client.name} con ${a.employee.name}`,
        // Floating wall-clock strings: the calendar shows the tenant time whatever the browser zone.
        start: toDateTimeLocalValue(a.date, tz),
        end: toDateTimeLocalValue(addMinutes(a.date, a.durationMinutes), tz),
        color: employeeColor(a.employeeId),
        contrastColor: '#ffffff',
        className: a.status === 'cancelled' ? 'appointment-cancelled' : a.attendance === 'no_show' ? 'appointment-no-show' : '',
      })),
    [list.data, tz, showCancelled],
  );

  const timeOffEvents = useMemo<EventInput[]>(
    () =>
      (timeOff.data ?? []).map((t) => {
        const wholeDays = isWholeLocalDays(t.startsAt, t.endsAt, tz);
        const range = wholeDays
          ? { allDay: true, start: toZonedDateKey(t.startsAt, tz), end: toZonedDateKey(t.endsAt, tz) }
          : { start: toDateTimeLocalValue(t.startsAt, tz), end: toDateTimeLocalValue(t.endsAt, tz) };
        if (t.employeeId === null) {
          // Clinic closure: shaded background over the whole calendar.
          return { id: `timeoff:${t.id}`, ...range, display: 'background', className: 'time-off-clinic', title: `Cerrado${t.reason ? `: ${t.reason}` : ''}` };
        }
        return {
          id: `timeoff:${t.id}`,
          ...range,
          title: `Ausencia: ${t.employee?.name ?? ''}${t.reason ? ` · ${t.reason}` : ''}`,
          color: employeeColor(t.employeeId),
          contrastColor: '#ffffff',
          className: 'time-off-employee',
        };
      }),
    [timeOff.data, tz],
  );
  const allEvents = useMemo(() => [...timeOffEvents, ...events], [timeOffEvents, events]);

  const legend = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of list.data ?? []) map.set(a.employeeId, a.employee.name);
    return [...map.entries()];
  }, [list.data]);

  const onRangeChange = useCallback(
    (start: Date, end: Date) => setRange({ from: calendarDateToInstant(start, tz), to: calendarDateToInstant(end, tz) }),
    [tz],
  );

  const openCreate = (start?: Date) => setDialog({ open: true, ...(start ? { start } : {}) });
  const openEdit = (appointment: AppointmentItem) => setDialog({ open: true, appointment });

  const onDateClick = (date: Date, allDay: boolean) => {
    let start = calendarDateToInstant(date, tz);
    if (allDay) {
      const p = getZonedParts(start, tz);
      start = zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: 10 }, tz);
    }
    openCreate(start);
  };

  const onEventClick = (id: string) => {
    const appointment = list.data?.find((a) => a.id === id);
    if (appointment) openEdit(appointment);
  };

  return (
    <>
      <PageHeader
        title="Calendario"
        description="Pulsa un hueco para crear una cita o una cita para editarla. Las reservas de WhatsApp aparecen solas."
        actions={
          <div className="flex flex-wrap gap-2">
            {/* F28: subscribe to the agenda from Google, Apple or Outlook. */}
            <Button variant="outline" onClick={() => setAgendaOpen(true)}>
              <SmartphoneIcon /> Ver en el móvil
            </Button>
            <Button onClick={() => openCreate()}>
              <PlusIcon /> Nueva Cita
            </Button>
          </div>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
        <Card className="h-fit lg:sticky lg:top-24">
          <CardHeader>
            <CardTitle>Próximas citas</CardTitle>
          </CardHeader>
          <CardContent>
            {upcoming.isLoading ? (
              <>
                <Skeleton className="h-14" />
                <Skeleton className="h-14" />
              </>
            ) : upcomingShown.length === 0 ? (
              <p className="text-sm text-muted-foreground">No hay citas próximas.</p>
            ) : (
              <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto lg:max-h-none lg:overflow-visible" aria-label="Próximas citas">
                {upcomingShown.map((a) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      onClick={() => openEdit(a)}
                      className="flex w-full min-w-0 items-start gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-accent"
                    >
                      <span className="mt-1.5 size-2.5 shrink-0 rounded-full" style={{ backgroundColor: employeeColor(a.employeeId) }} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {a.client.name} con {a.employee.name}
                        </span>
                        <span className="block text-xs text-muted-foreground">{formatHumanDateTime(a.date, tz)}</span>
                        <span className="mt-1.5 block">
                          <StatusBadge status={a.status} />
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <div className="min-w-0">
          <div className="clinicai-calendar rounded-xl border bg-background p-3 sm:p-4">
            <CalendarCanvas events={allEvents} onRangeChange={onRangeChange} onDateClick={onDateClick} onEventClick={onEventClick} />
          </div>
          <div className="mt-3 flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
            {legend.length > 0 ? (
              <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Leyenda de profesionales">
                {legend.map(([id, name]) => (
                  <li key={id} className="flex items-center gap-1.5">
                    <span className="size-2.5 rounded-full" style={{ backgroundColor: employeeColor(id) }} />
                    {name}
                  </li>
                ))}
              </ul>
            ) : (
              <span />
            )}
            {cancelledCount > 0 || showCancelled ? (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={showCancelled}
                  onChange={(e) => setShowCancelled(e.target.checked)}
                />
                Ver canceladas ({cancelledCount})
              </label>
            ) : null}
          </div>
        </div>
      </div>

      <AppointmentDialog state={dialog} onOpenChange={(open) => setDialog((d) => ({ ...d, open }))} />
      <AgendaLinkDialog open={agendaOpen} onOpenChange={setAgendaOpen} />
    </>
  );
}
