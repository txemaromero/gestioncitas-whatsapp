'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { formatDuration, toZonedDateKey } from '@clinicai/shared';
import { useTenant } from '@/components/layout/tenant-context';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, Input, NativeSelect } from '@/components/ui/form-controls';
import { errorMessage } from '@/lib/utils';
import { useTRPC } from '@/trpc/react';

const EMPTY = { clientId: '', serviceId: '', day: '', time: '', onlyThatTime: false };

/**
 * F21: the clinic adds a client to the waiting list (e.g. someone who phoned). Only clients with a
 * phone who accepted the privacy notice can be offered slots by WhatsApp.
 */
export function AddToWaitlistDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const trpc = useTRPC();
  const tenant = useTenant();
  const queryClient = useQueryClient();
  const [form, setForm] = useState(EMPTY);
  const clients = useQuery({ ...trpc.clients.list.queryOptions({}), enabled: open });
  const services = useQuery({ ...trpc.services.list.queryOptions(), enabled: open });
  const add = useMutation(
    trpc.waitlist.add.mutationOptions({
      onSuccess: () => {
        toast.success('Añadido a la lista de espera. Si hay un hueco libre, el bot le avisará por WhatsApp.');
        setForm(EMPTY);
        onOpenChange(false);
        void queryClient.invalidateQueries({ queryKey: trpc.waitlist.pathKey() });
      },
      onError: (e) => toast.error(errorMessage(e)),
    }),
  );

  const reachable = (clients.data ?? []).filter((c) => c.phone && c.consentAt);
  const activeServices = (services.data ?? []).filter((s) => s.active);
  const today = toZonedDateKey(new Date(), tenant.timezone);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Añadir a la lista de espera</DialogTitle>
          <DialogDescription>
            Cuando se libere un hueco ese día, el bot se lo ofrecerá por WhatsApp para que lo reserve con un botón. Solo
            aparecen los clientes con teléfono que han aceptado el aviso de privacidad.
          </DialogDescription>
        </DialogHeader>
        <form
          id="waitlist-form"
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate({
              clientId: form.clientId,
              serviceId: form.serviceId || null,
              day: form.day,
              time: form.time || null,
              onlyThatTime: Boolean(form.time) && form.onlyThatTime,
            });
          }}
        >
          <Field label="Cliente" htmlFor="waitlist-client" required>
            <Combobox
              id="waitlist-client"
              value={form.clientId}
              onChange={(clientId) => setForm({ ...form, clientId })}
              placeholder={clients.isLoading ? 'Cargando clientes…' : 'Selecciona un cliente'}
              searchPlaceholder="Buscar cliente…"
              emptyText="No hay clientes con ese nombre"
              options={reachable.map((c) => ({ value: c.id, label: c.name, description: c.phone }))}
            />
          </Field>
          {activeServices.length > 0 ? (
            <Field label="Servicio" htmlFor="waitlist-service">
              <NativeSelect id="waitlist-service" value={form.serviceId} onChange={(e) => setForm({ ...form, serviceId: e.target.value })}>
                <option value="">Cita normal ({formatDuration(tenant.slotMinutes)})</option>
                {activeServices.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({formatDuration(s.durationMinutes)})
                  </option>
                ))}
              </NativeSelect>
            </Field>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Día" htmlFor="waitlist-day" required>
              <Input id="waitlist-day" type="date" min={today} value={form.day} onChange={(e) => setForm({ ...form, day: e.target.value })} required />
            </Field>
            <Field label="Hora preferida" htmlFor="waitlist-time" hint="Opcional: se ofrece el hueco más cercano.">
              <Input id="waitlist-time" type="time" step={300} value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} />
            </Field>
          </div>
          <label htmlFor="waitlist-only" className="flex items-start gap-2 text-sm font-medium">
            <input
              id="waitlist-only"
              type="checkbox"
              className="mt-0.5 size-4 accent-primary"
              checked={form.onlyThatTime}
              disabled={!form.time}
              onChange={(e) => setForm({ ...form, onlyThatTime: e.target.checked })}
            />
            Solo a esa hora (si no, cualquier hueco de ese día)
          </label>
        </form>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Cancelar
            </Button>
          </DialogClose>
          <Button type="submit" form="waitlist-form" disabled={add.isPending || !form.clientId || !form.day}>
            {add.isPending ? 'Añadiendo…' : 'Añadir'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
