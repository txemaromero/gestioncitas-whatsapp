'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { formatEsShort, fromDateTimeLocalValue, localDaysRange, toZonedDateKey } from '@clinicai/shared';
import { useTenant } from '@/components/layout/tenant-context';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form-controls';
import { Skeleton } from '@/components/ui/misc';
import { formatTimeOffRange } from '@/lib/time-off';
import { errorMessage } from '@/lib/utils';
import { useTRPC } from '@/trpc/react';

/**
 * Upcoming time off + form to add it (F14): absences of a professional (`employeeId`) or
 * closures of the whole clinic (`employeeId` null). Whole days by default, or some hours of a day.
 */
export function TimeOffPanel({ employeeId, reasonPlaceholder }: { employeeId: string | null; reasonPlaceholder: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const tenant = useTenant();
  const tz = tenant.timezone;
  const [today] = useState(() => toZonedDateKey(new Date(), tz));
  const [mode, setMode] = useState<'days' | 'hours'>('days');
  const [form, setForm] = useState({ from: today, to: today, day: today, fromTime: '09:00', toTime: '14:00', reason: '' });
  const [error, setError] = useState<string | null>(null);

  const upcoming = useQuery(trpc.timeOff.upcoming.queryOptions({ employeeId }));
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.timeOff.pathKey() });
    void queryClient.invalidateQueries({ queryKey: trpc.appointments.pathKey() });
  };
  const create = useMutation(
    trpc.timeOff.create.mutationOptions({
      onSuccess: (result) => {
        toast.success(employeeId ? 'Ausencia guardada' : 'Cierre guardado');
        if (result.overlapping.length > 0) {
          const first = result.overlapping
            .slice(0, 3)
            .map((a) => `${formatEsShort(a.date, tz)} (${a.client})`)
            .join(', ');
          toast.warning(
            `Ojo: hay ${result.overlapping.length} cita(s) en ese periodo que siguen en pie: ${first}. Revísalas en el calendario.`,
            { duration: 10_000 },
          );
        }
        setForm((f) => ({ ...f, reason: '' }));
        refresh();
      },
      onError: (e) => setError(errorMessage(e)),
    }),
  );
  const remove = useMutation(
    trpc.timeOff.delete.mutationOptions({
      onSuccess: () => {
        toast.success('Eliminado');
        refresh();
      },
      onError: (e) => toast.error(errorMessage(e)),
    }),
  );

  const submit = () => {
    setError(null);
    const range =
      mode === 'days'
        ? localDaysRange(form.from, form.to, tz)
        : (() => {
            const start = fromDateTimeLocalValue(`${form.day}T${form.fromTime}`, tz);
            const end = fromDateTimeLocalValue(`${form.day}T${form.toTime}`, tz);
            return start && end && end > start ? { start, end } : null;
          })();
    if (!range) {
      setError(mode === 'days' ? 'La fecha final no puede ser anterior a la inicial.' : 'La hora final debe ser posterior a la inicial.');
      return;
    }
    create.mutate({ employeeId, startsAt: range.start, endsAt: range.end, ...(form.reason.trim() ? { reason: form.reason.trim() } : {}) });
  };

  const items = upcoming.data ?? [];
  const idPrefix = employeeId ? `off-${employeeId.slice(0, 8)}` : 'off-clinic';

  return (
    <div className="grid gap-4">
      {upcoming.isLoading ? (
        <Skeleton className="h-16" />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{employeeId ? 'No hay ausencias previstas.' : 'No hay cierres previstos.'}</p>
      ) : (
        <ul className="grid gap-2" aria-label={employeeId ? 'Ausencias previstas' : 'Cierres previstos'}>
          {items.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
              <span className="min-w-0">
                <span className="block text-sm font-medium first-letter:uppercase">{formatTimeOffRange(t.startsAt, t.endsAt, tz)}</span>
                {t.reason ? <span className="block truncate text-xs text-muted-foreground">{t.reason}</span> : null}
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Eliminar ${t.reason ?? 'ausencia'} (${formatTimeOffRange(t.startsAt, t.endsAt, tz)})`}
                disabled={remove.isPending}
                onClick={() => remove.mutate({ id: t.id })}
              >
                <Trash2Icon className="text-destructive" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <form
        className="grid gap-3 rounded-lg border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        noValidate
      >
        <fieldset className="flex flex-wrap gap-4 text-sm">
          <legend className="sr-only">Duración</legend>
          <label className="flex items-center gap-2">
            <input type="radio" name={`${idPrefix}-mode`} className="accent-primary" checked={mode === 'days'} onChange={() => setMode('days')} />
            Días completos
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name={`${idPrefix}-mode`} className="accent-primary" checked={mode === 'hours'} onChange={() => setMode('hours')} />
            Unas horas
          </label>
        </fieldset>
        {mode === 'days' ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Desde" htmlFor={`${idPrefix}-from`}>
              <Input id={`${idPrefix}-from`} type="date" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value, to: form.to < e.target.value ? e.target.value : form.to })} />
            </Field>
            <Field label="Hasta (incluido)" htmlFor={`${idPrefix}-to`}>
              <Input id={`${idPrefix}-to`} type="date" min={form.from} value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />
            </Field>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Día" htmlFor={`${idPrefix}-day`}>
              <Input id={`${idPrefix}-day`} type="date" value={form.day} onChange={(e) => setForm({ ...form, day: e.target.value })} />
            </Field>
            <Field label="De" htmlFor={`${idPrefix}-fromTime`}>
              <Input id={`${idPrefix}-fromTime`} type="time" value={form.fromTime} onChange={(e) => setForm({ ...form, fromTime: e.target.value })} />
            </Field>
            <Field label="A" htmlFor={`${idPrefix}-toTime`}>
              <Input id={`${idPrefix}-toTime`} type="time" value={form.toTime} onChange={(e) => setForm({ ...form, toTime: e.target.value })} />
            </Field>
          </div>
        )}
        <Field label="Motivo" htmlFor={`${idPrefix}-reason`} hint="Opcional. Solo lo ve el personal de la clínica.">
          <Input id={`${idPrefix}-reason`} maxLength={120} placeholder={reasonPlaceholder} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
        </Field>
        {error ? (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <Button type="submit" className="w-fit" disabled={create.isPending}>
          {create.isPending ? 'Guardando…' : employeeId ? 'Añadir Ausencia' : 'Añadir Cierre'}
        </Button>
      </form>
    </div>
  );
}
