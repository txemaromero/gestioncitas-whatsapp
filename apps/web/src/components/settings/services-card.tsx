'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckIcon, PencilIcon, Trash2Icon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { formatDuration, SERVICE_DURATION_OPTIONS } from '@clinicai/shared';
import { Button } from '@/components/ui/button';
import { Field, Input, NativeSelect } from '@/components/ui/form-controls';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from '@/components/ui/misc';
import { errorMessage } from '@/lib/utils';
import { useTRPC } from '@/trpc/react';

function DurationSelect({ id, value, onChange }: { id: string; value: number; onChange: (value: number) => void }) {
  const options = (SERVICE_DURATION_OPTIONS as readonly number[]).includes(value) ? SERVICE_DURATION_OPTIONS : [...SERVICE_DURATION_OPTIONS, value].sort((a, b) => a - b);
  return (
    <NativeSelect id={id} value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {options.map((m) => (
        <option key={m} value={m}>
          {formatDuration(m)}
        </option>
      ))}
    </NativeSelect>
  );
}

/** Services of the clinic with their duration (F14). With two or more, the bot asks which one. */
export function ServicesCard() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const services = useQuery(trpc.services.list.queryOptions());
  const [draft, setDraft] = useState({ name: '', durationMinutes: 60 });
  const [editing, setEditing] = useState<{ id: string; name: string; durationMinutes: number } | null>(null);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: trpc.services.pathKey() });
  const onError = (e: unknown) => toast.error(errorMessage(e));
  const create = useMutation(
    trpc.services.create.mutationOptions({
      onSuccess: () => {
        toast.success('Servicio añadido');
        setDraft({ name: '', durationMinutes: 60 });
        refresh();
      },
      onError,
    }),
  );
  const update = useMutation(
    trpc.services.update.mutationOptions({
      onSuccess: () => {
        toast.success('Servicio actualizado');
        setEditing(null);
        refresh();
      },
      onError,
    }),
  );
  const setActive = useMutation(trpc.services.setActive.mutationOptions({ onSuccess: refresh, onError }));
  const remove = useMutation(
    trpc.services.delete.mutationOptions({
      onSuccess: () => {
        toast.success('Servicio eliminado');
        refresh();
      },
      onError,
    }),
  );

  const list = services.data ?? [];
  const active = list.filter((s) => s.active).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Servicios</CardTitle>
        <CardDescription>
          Cada servicio tiene su propia duración. Con dos o más servicios activos, el bot pregunta cuál quiere el cliente antes
          de la fecha; sin servicios, usa la duración de la cita de la clínica.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {services.isLoading ? (
          <Skeleton className="h-24" />
        ) : list.length === 0 ? (
          <p className="text-sm text-muted-foreground">Todavía no hay servicios.</p>
        ) : (
          <ul className="grid gap-2" aria-label="Servicios">
            {list.map((s) =>
              editing?.id === s.id ? (
                <li key={s.id} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_9rem_auto] sm:items-end">
                  <Field label="Nombre" htmlFor={`service-name-${s.id}`}>
                    <Input id={`service-name-${s.id}`} value={editing.name} maxLength={60} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                  </Field>
                  <Field label="Duración" htmlFor={`service-duration-${s.id}`}>
                    <DurationSelect id={`service-duration-${s.id}`} value={editing.durationMinutes} onChange={(v) => setEditing({ ...editing, durationMinutes: v })} />
                  </Field>
                  <span className="flex gap-1">
                    <Button size="icon" aria-label="Guardar servicio" disabled={update.isPending} onClick={() => update.mutate(editing)}>
                      <CheckIcon />
                    </Button>
                    <Button size="icon" variant="outline" aria-label="Cancelar edición" onClick={() => setEditing(null)}>
                      <XIcon />
                    </Button>
                  </span>
                </li>
              ) : (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 text-sm font-medium">
                      {s.name}
                      {s.active ? null : <Badge variant="muted">Inactivo</Badge>}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {formatDuration(s.durationMinutes)} · {s.appointments === 1 ? '1 cita' : `${s.appointments} citas`}
                    </span>
                  </span>
                  <span className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={setActive.isPending}
                      onClick={() => setActive.mutate({ id: s.id, active: !s.active })}
                    >
                      {s.active ? 'Desactivar' : 'Activar'}
                    </Button>
                    <Button variant="ghost" size="icon" aria-label={`Editar ${s.name}`} onClick={() => setEditing({ id: s.id, name: s.name, durationMinutes: s.durationMinutes })}>
                      <PencilIcon />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Eliminar ${s.name}`}
                      title={s.appointments > 0 ? 'Tiene citas: desactívalo en su lugar' : undefined}
                      disabled={s.appointments > 0 || remove.isPending}
                      onClick={() => remove.mutate({ id: s.id })}
                    >
                      <Trash2Icon className="text-destructive" />
                    </Button>
                  </span>
                </li>
              ),
            )}
          </ul>
        )}
        {active === 1 ? (
          <p className="text-xs text-muted-foreground">Con un único servicio activo, el bot lo usa sin preguntar.</p>
        ) : null}

        <form
          className="grid gap-3 sm:grid-cols-[1fr_9rem_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate({ name: draft.name.trim(), durationMinutes: draft.durationMinutes });
          }}
        >
          <Field label="Nuevo servicio" htmlFor="new-service-name">
            <Input id="new-service-name" placeholder="Punción seca" maxLength={60} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </Field>
          <Field label="Duración" htmlFor="new-service-duration">
            <DurationSelect id="new-service-duration" value={draft.durationMinutes} onChange={(v) => setDraft({ ...draft, durationMinutes: v })} />
          </Field>
          <Button type="submit" disabled={create.isPending || draft.name.trim().length < 2}>
            Añadir Servicio
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
