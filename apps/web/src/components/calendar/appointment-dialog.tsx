'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangleIcon, CheckCircle2Icon, RepeatIcon, TicketIcon, Trash2Icon, XCircleIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import {
  formatDuration,
  formatEsShort,
  fromDateTimeLocalValue,
  getZonedParts,
  isAdminRole,
  SERIES_MAX_SESSIONS,
  SERIES_MIN_SESSIONS,
  toDateTimeLocalValue,
  type AttendanceValue,
} from '@clinicai/shared';
import { useTenant } from '@/components/layout/tenant-context';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/form-controls';
import { AttendanceButtons } from '@/components/attendance/attendance-buttons';
import { AttendanceBadge } from '@/components/ui/misc';
import { formatTimeOffRange } from '@/lib/time-off';
import { errorMessage } from '@/lib/utils';
import type { RouterOutputs } from '@/server/routers/_app';
import { useTRPC } from '@/trpc/react';
import { SeriesFields, type SeriesPatternValue, type SeriesPlanView } from './series-fields';

/** Placeholder id for disabled queries (a valid UUID that never exists). */
const NO_ID = '00000000-0000-4000-8000-000000000000';
const DEFAULT_PATTERN: SeriesPatternValue = { weekdays: [], intervalWeeks: 1, sessions: 10 };

export type AppointmentItem = RouterOutputs['appointments']['list'][number];

const schema = z.object({
  clientId: z.string().min(1, 'Selecciona un cliente'),
  employeeId: z.string().min(1, 'Selecciona un empleado'),
  /** '' = no service (F14). */
  serviceId: z.string(),
  status: z.enum(['pending', 'confirmed', 'cancelled']),
  startLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Indica una fecha y hora válidas'),
  notes: z.string().max(1000),
  force: z.boolean(),
});
type Values = z.infer<typeof schema>;

export interface AppointmentDialogState {
  open: boolean;
  appointment?: AppointmentItem;
  /** Initial start (create mode). */
  start?: Date;
}

export function AppointmentDialog({ state, onOpenChange: setOpen }: { state: AppointmentDialogState; onOpenChange: (open: boolean) => void }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const tenant = useTenant();
  const tz = tenant.timezone;
  const editing = state.appointment;
  const [confirmDelete, setConfirmDelete] = useState(false);
  // F15: attendance marked from this dialog (the appointment in `state` is a snapshot).
  const [openedAt] = useState(() => Date.now());
  const [marked, setMarked] = useState<Record<string, AttendanceValue | null>>({});
  const attendance = editing ? (Object.hasOwn(marked, editing.id) ? (marked[editing.id] ?? null) : editing.attendance) : null;
  // F26: treatment (create mode). The plan is kept with the inputs it was made for.
  const [repeat, setRepeat] = useState(false);
  const [pattern, setPattern] = useState<SeriesPatternValue>(DEFAULT_PATTERN);
  const [plan, setPlan] = useState<{ key: string; data: SeriesPlanView } | null>(null);
  const [planning, setPlanning] = useState(false);
  const [confirmCancelFollowing, setConfirmCancelFollowing] = useState(false);
  const onOpenChange = (open: boolean) => {
    if (!open) {
      setRepeat(false);
      setPattern(DEFAULT_PATTERN);
      setPlan(null);
    }
    setOpen(open);
  };

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { clientId: '', employeeId: '', serviceId: '', status: 'pending', startLocal: '', notes: '', force: false },
  });

  useEffect(() => {
    if (!state.open) return;
    form.reset(
      editing
        ? {
            clientId: editing.clientId,
            employeeId: editing.employeeId,
            serviceId: editing.serviceId ?? '',
            status: editing.status,
            startLocal: toDateTimeLocalValue(editing.date, tz),
            notes: editing.notes ?? '',
            force: false,
          }
        : {
            clientId: '',
            // A professional books for themselves.
            employeeId: tenant.employeeId ?? '',
            serviceId: '',
            status: 'pending',
            startLocal: state.start ? toDateTimeLocalValue(state.start, tz) : '',
            notes: '',
            force: false,
          },
    );
  }, [state.open, editing, state.start, tz, form, tenant.employeeId]);

  // F18: every member can pick a client (only id, name and phone are loaded).
  const clients = useQuery({ ...trpc.clients.options.queryOptions(), enabled: state.open });
  const employees = useQuery({ ...trpc.employees.list.queryOptions({}), enabled: state.open });
  const services = useQuery({ ...trpc.services.list.queryOptions(), enabled: state.open });

  const [startLocal, employeeId, serviceId, clientId] = useWatch({ control: form.control, name: ['startLocal', 'employeeId', 'serviceId', 'clientId'] });
  const start = useMemo(() => (startLocal ? fromDateTimeLocalValue(startLocal, tz) : null), [startLocal, tz]);
  // Duration (F14): the chosen service's; when editing without changing it, the appointment's own.
  const service = (services.data ?? []).find((s) => s.id === serviceId);
  const durationMinutes =
    editing && serviceId === (editing.serviceId ?? '') ? editing.durationMinutes : (service?.durationMinutes ?? tenant.slotMinutes);
  const serviceOptions = (services.data ?? []).filter((s) => s.active || s.id === serviceId);
  const availability = useQuery({
    ...trpc.appointments.checkAvailability.queryOptions({
      start: start ?? new Date(0),
      durationMinutes,
      ...(employeeId ? { employeeId } : {}),
      ...(editing ? { ignoreAppointmentId: editing.id } : {}),
    }),
    enabled: state.open && start !== null,
  });
  // F26: place in the treatment and pack (existing appointment); the pack it would spend (new one).
  const details = useQuery({ ...trpc.appointments.details.queryOptions({ id: editing?.id ?? NO_ID }), enabled: state.open && Boolean(editing) });
  const hint = useQuery({
    ...trpc.packs.hint.queryOptions({ clientId: clientId || NO_ID, serviceId: serviceId || null, date: start ?? new Date(0) }),
    enabled: state.open && !editing && Boolean(clientId) && start !== null,
  });
  const packInfo = editing ? details.data?.pack : hint.data;
  const planKey = JSON.stringify([clientId, employeeId, serviceId, startLocal, pattern]);
  const currentPlan = repeat && plan?.key === planKey ? plan.data : null;
  const check = availability.data?.check;
  const available = new Set(availability.data?.availableEmployeeIds ?? []);
  // The selected employee uses the detailed check, which ignores the appointment being edited.
  const isAvailable = (id: string) =>
    id === employeeId && check ? check.active && check.withinSchedule && !check.conflict && !check.timeOff : available.has(id);
  // F32: keeping an appointment where it already is (e.g. editing its notes) needs no override.
  const samePlacement = Boolean(
    editing && start && employeeId === editing.employeeId && start.getTime() === editing.date.getTime() && durationMinutes === editing.durationMinutes,
  );
  const outsideSchedule = Boolean(check && (!check.withinSchedule || !check.active)) && !samePlacement;
  const timeOff = check?.timeOff ?? null;
  // Time off (F14) blocks like a conflict: it cannot be forced.
  const conflict = Boolean(check?.conflict) || timeOff !== null;

  const invalidate = () => queryClient.invalidateQueries({ queryKey: trpc.appointments.pathKey() });
  const done = (message: string) => {
    toast.success(message);
    void invalidate();
    onOpenChange(false);
  };
  const createMutation = useMutation(
    trpc.appointments.create.mutationOptions({ onSuccess: () => done('Cita creada'), onError: (e) => toast.error(errorMessage(e)) }),
  );
  const updateMutation = useMutation(
    trpc.appointments.update.mutationOptions({ onSuccess: () => done('Cita actualizada'), onError: (e) => toast.error(errorMessage(e)) }),
  );
  const createSeriesMutation = useMutation(
    trpc.appointments.createSeries.mutationOptions({
      onSuccess: (result) => done(`Tratamiento creado: ${result?.sessions ?? 0} citas`),
      onError: (e) => {
        toast.error(errorMessage(e));
        // The dates changed: ask for them again.
        setPlan(null);
      },
    }),
  );
  const cancelFollowingMutation = useMutation(
    trpc.appointments.cancelFollowing.mutationOptions({
      onSuccess: (result) => {
        setConfirmCancelFollowing(false);
        done(result.cancelled === 1 ? 'Cancelada 1 cita del tratamiento' : `Canceladas ${result.cancelled} citas del tratamiento`);
      },
      onError: (e) => toast.error(errorMessage(e)),
    }),
  );
  const deleteMutation = useMutation(
    trpc.appointments.delete.mutationOptions({
      onSuccess: () => {
        setConfirmDelete(false);
        done('Cita eliminada');
      },
      onError: (e) => toast.error(errorMessage(e)),
    }),
  );

  const toggleRepeat = (on: boolean) => {
    setRepeat(on);
    // The weekday of the chosen date, to start with.
    if (on && pattern.weekdays.length === 0 && start) setPattern({ ...pattern, weekdays: [getZonedParts(start, tz).weekday] });
  };

  /** F26: first «Ver fechas» (plan), then «Reservar N sesiones» (exactly those dates). */
  const submitSeries = async (values: Values, startDate: Date) => {
    if (pattern.weekdays.length === 0) {
      toast.error('Elige al menos un día de la semana');
      return;
    }
    if (!Number.isInteger(pattern.sessions) || pattern.sessions < SERIES_MIN_SESSIONS || pattern.sessions > SERIES_MAX_SESSIONS) {
      toast.error(`Indica entre ${SERIES_MIN_SESSIONS} y ${SERIES_MAX_SESSIONS} sesiones`);
      return;
    }
    const input = {
      clientId: values.clientId,
      employeeId: values.employeeId,
      serviceId: values.serviceId || null,
      first: startDate,
      weekdays: pattern.weekdays,
      intervalWeeks: pattern.intervalWeeks,
      sessions: pattern.sessions,
    };
    if (!currentPlan) {
      setPlanning(true);
      try {
        const data = await queryClient.fetchQuery({ ...trpc.appointments.planSeries.queryOptions(input), staleTime: 0 });
        if (data) setPlan({ key: planKey, data });
      } catch (error) {
        toast.error(errorMessage(error));
      } finally {
        setPlanning(false);
      }
      return;
    }
    createSeriesMutation.mutate({
      ...input,
      status: values.status === 'confirmed' ? 'confirmed' : 'pending',
      notes: values.notes.trim() || null,
      expected: currentPlan.sessions,
    });
  };

  const onSubmit = (values: Values) => {
    const startDate = fromDateTimeLocalValue(values.startLocal, tz);
    if (!startDate) {
      form.setError('startLocal', { message: 'Fecha no válida' });
      return;
    }
    if (repeat && !editing) {
      void submitSeries(values, startDate);
      return;
    }
    if (outsideSchedule && !values.force && values.status !== 'cancelled') {
      form.setError('force', {
        message: isAdminRole(tenant.role)
          ? 'Marca la casilla para crear la cita fuera del horario del empleado'
          : 'Fuera del horario: solo un administrador puede crear esta cita',
      });
      return;
    }
    const payload = {
      clientId: values.clientId,
      employeeId: values.employeeId,
      status: values.status,
      start: startDate,
      durationMinutes,
      serviceId: values.serviceId || null,
      notes: values.notes.trim() || null,
      force: values.force,
    };
    if (editing) updateMutation.mutate({ ...payload, id: editing.id });
    else createMutation.mutate(payload);
  };

  const { errors } = form.formState;
  const pending = createMutation.isPending || updateMutation.isPending || createSeriesMutation.isPending || planning;
  const series = editing ? details.data?.series : null;
  const submitLabel = pending
    ? planning
      ? 'Buscando fechas…'
      : 'Guardando…'
    : editing
      ? 'Actualizar cita'
      : repeat
        ? currentPlan
          ? `Reservar ${currentPlan.sessions.length} sesiones`
          : 'Ver fechas'
        : 'Crear Cita';
  const activeEmployees = (employees.data ?? []).filter(
    (e) => (e.active || e.id === employeeId) && (!tenant.employeeId || e.id === tenant.employeeId),
  );

  return (
    <>
      <Dialog open={state.open} onOpenChange={onOpenChange}>
        <DialogContent aria-describedby="appointment-dialog-description">
          <DialogHeader>
            <DialogTitle>{editing ? 'Editar Cita' : 'Nueva Cita'}</DialogTitle>
            <DialogDescription id="appointment-dialog-description">
              {editing ? 'Modifica los datos de la cita o elimínala.' : 'Registra una cita en el calendario de la clínica.'}
            </DialogDescription>
          </DialogHeader>

          <form id="appointment-form" className="grid gap-4" onSubmit={form.handleSubmit(onSubmit)} noValidate>
            <Field label="Cliente" htmlFor="clientId" required error={errors.clientId?.message}>
              <Controller
                control={form.control}
                name="clientId"
                render={({ field }) => (
                  <Combobox
                    id="clientId"
                    value={field.value}
                    onChange={field.onChange}
                    invalid={!!errors.clientId}
                    placeholder={clients.isLoading ? 'Cargando clientes…' : 'Selecciona un cliente'}
                    searchPlaceholder="Buscar cliente…"
                    emptyText="No hay clientes con ese nombre"
                    options={(clients.data ?? []).map((c) => ({ value: c.id, label: c.name, description: c.phone }))}
                  />
                )}
              />
            </Field>

            {serviceOptions.length > 0 ? (
              <Field label="Servicio" htmlFor="serviceId" hint={`Duración: ${formatDuration(durationMinutes)}`}>
                <NativeSelect key={`services-${serviceOptions.length}`} id="serviceId" {...form.register('serviceId')}>
                  <option value="">Sin servicio ({formatDuration(editing && !editing.serviceId ? editing.durationMinutes : tenant.slotMinutes)})</option>
                  {serviceOptions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} · {formatDuration(s.durationMinutes)}
                      {s.active ? '' : ' (inactivo)'}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            ) : null}

            <Field label="Fecha y hora" htmlFor="startLocal" required hint="Formato español: 04/06/2025, 12:00" error={errors.startLocal?.message}>
              <Input id="startLocal" type="datetime-local" step={300} aria-invalid={!!errors.startLocal} {...form.register('startLocal')} />
            </Field>

            <Field label="Empleado" htmlFor="employeeId" required error={errors.employeeId?.message}>
              {/* Re-mounted when the options arrive so the registered value shows up when editing. */}
              <NativeSelect key={`employees-${activeEmployees.length}`} id="employeeId" aria-invalid={!!errors.employeeId} {...form.register('employeeId')}>
                <option value="">Selecciona un empleado</option>
                {activeEmployees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                    {start ? (isAvailable(e.id) ? ' · disponible' : ' · no disponible') : ''}
                  </option>
                ))}
              </NativeSelect>
            </Field>

            {employeeId && start && check ? (
              timeOff ? (
                <p className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900" role="alert">
                  <XCircleIcon className="mt-0.5 size-4 shrink-0" />
                  <span>
                    {timeOff.clinicWide ? 'La clínica está cerrada' : 'El empleado está ausente'}{' '}
                    <span className="first-letter:lowercase">({formatTimeOffRange(timeOff.start, timeOff.end, tz)})</span>
                    {timeOff.reason ? `: ${timeOff.reason}` : ''}. Elige otra hora u otro profesional.
                  </span>
                </p>
              ) : conflict ? (
                <p className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900" role="alert">
                  <XCircleIcon className="mt-0.5 size-4 shrink-0" />
                  El empleado ya tiene una cita que se solapa con ese horario. Elige otra hora u otro profesional.
                </p>
              ) : outsideSchedule ? (
                <div className="grid gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" role="alert">
                  <p className="flex items-start gap-2">
                    <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
                    {check.active ? 'La cita queda fuera del horario del empleado.' : 'El empleado está desactivado.'}
                  </p>
                  {/* F32: forcing it is an administrator override. */}
                  {isAdminRole(tenant.role) ? (
                    <label className="flex items-center gap-2 font-medium">
                      <input type="checkbox" className="size-4 accent-primary" {...form.register('force')} />
                      Crear igualmente (forzar fuera de su horario)
                    </label>
                  ) : (
                    <p>Elige otra hora o pide a un administrador de la clínica que cree esta cita.</p>
                  )}
                  {errors.force ? <p className="text-xs text-destructive">{errors.force.message}</p> : null}
                </div>
              ) : (
                <p className="flex items-center gap-2 text-sm text-emerald-700">
                  <CheckCircle2Icon className="size-4" /> Disponible el {formatEsShort(start, tz)}
                </p>
              )
            ) : null}

            {packInfo ? (
              <p className="flex items-start gap-2 text-sm text-muted-foreground">
                <TicketIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                {packInfo.spentHere
                  ? `Sesión descontada del bono «${packInfo.name}»: quedan ${packInfo.remaining} de ${packInfo.totalSessions}.`
                  : `Bono «${packInfo.name}»: quedan ${packInfo.remaining} de ${packInfo.totalSessions} sesiones.`}
              </p>
            ) : null}

            {series ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm">
                <span className="flex items-center gap-2">
                  <RepeatIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                  {series.index ? `Sesión ${series.index} de ${series.total} del tratamiento` : `Tratamiento de ${series.total} sesiones`}
                </span>
                {editing && editing.status !== 'cancelled' ? (
                  <Button type="button" variant="outline" size="sm" onClick={() => setConfirmCancelFollowing(true)}>
                    Cancelar esta y las siguientes
                  </Button>
                ) : null}
              </div>
            ) : null}

            {!editing ? (
              <div className="grid gap-3 rounded-md border p-3">
                <label htmlFor="repeat" className="flex items-center gap-2 text-sm font-medium">
                  <input id="repeat" type="checkbox" className="size-4 accent-primary" checked={repeat} onChange={(e) => toggleRepeat(e.target.checked)} />
                  Repetir (tratamiento de varias sesiones)
                </label>
                {repeat ? <SeriesFields pattern={pattern} onChange={setPattern} plan={currentPlan} timeZone={tz} /> : null}
              </div>
            ) : null}

            {editing && editing.status !== 'cancelled' && editing.date.getTime() <= Math.max(openedAt, availability.dataUpdatedAt) ? (
              <div className="grid gap-2 rounded-md border p-3">
                <p className="flex items-center justify-between gap-2 text-sm font-medium">
                  Asistencia
                  {attendance ? <AttendanceBadge attendance={attendance} /> : <span className="text-xs font-normal text-muted-foreground">Sin marcar</span>}
                </p>
                <AttendanceButtons
                  appointmentId={editing.id}
                  attendance={attendance}
                  label={`${editing.client.name} con ${editing.employee.name}`}
                  onChanged={(value) => setMarked((m) => ({ ...m, [editing.id]: value }))}
                />
              </div>
            ) : null}

            <Field label="Estado" htmlFor="status" required>
              <NativeSelect id="status" {...form.register('status')}>
                <option value="pending">Pendiente</option>
                <option value="confirmed">Confirmada</option>
                {repeat && !editing ? null : <option value="cancelled">Cancelada</option>}
              </NativeSelect>
            </Field>

            <Field label="Detalles de la cita" htmlFor="notes" hint="Opcional">
              <Textarea id="notes" rows={3} placeholder="Motivo, observaciones…" {...form.register('notes')} />
            </Field>
          </form>

          <DialogFooter className="sm:justify-between">
            {editing ? (
              <Button type="button" variant="outline" className="text-destructive" onClick={() => setConfirmDelete(true)}>
                <Trash2Icon /> Eliminar Cita
              </Button>
            ) : (
              <span />
            )}
            <Button
              type="submit"
              form="appointment-form"
              disabled={
                pending ||
                (repeat && !editing ? currentPlan !== null && currentPlan.sessions.length === 0 : conflict && form.getValues('status') !== 'cancelled')
              }
            >
              {submitLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmCancelFollowing}
        onOpenChange={setConfirmCancelFollowing}
        title="¿Cancelar esta cita y las siguientes?"
        description="Se cancelarán esta sesión y las siguientes del tratamiento que no tengan la asistencia marcada. Los huecos se ofrecerán a la lista de espera."
        confirmLabel="Cancelar sesiones"
        cancelLabel="Volver"
        pending={cancelFollowingMutation.isPending}
        onConfirm={() => editing && cancelFollowingMutation.mutate({ id: editing.id })}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="¿Eliminar la cita?"
        description={
          editing
            ? `Se eliminará la cita de ${editing.client.name} con ${editing.employee.name} (${formatEsShort(editing.date, tz)}). Esta acción no se puede deshacer.`
            : undefined
        }
        confirmLabel="Eliminar Cita"
        pending={deleteMutation.isPending}
        onConfirm={() => editing && deleteMutation.mutate({ id: editing.id })}
      />
    </>
  );
}
