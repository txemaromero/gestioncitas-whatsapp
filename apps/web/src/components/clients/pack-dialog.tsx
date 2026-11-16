'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { defaultPackName, PACK_MAX_SESSIONS, PACK_NAME_MAX } from '@clinicai/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, Input, NativeSelect } from '@/components/ui/form-controls';
import { errorMessage } from '@/lib/utils';
import type { RouterOutputs } from '@/server/routers/_app';
import { useTRPC } from '@/trpc/react';

export type PackItem = RouterOutputs['packs']['list'][number];

const schema = z.object({
  name: z.string().trim().min(2, 'Escribe un nombre').max(PACK_NAME_MAX),
  totalSessions: z.number({ error: 'Indica el número de sesiones' }).int().min(1, 'Al menos 1 sesión').max(PACK_MAX_SESSIONS, `Como máximo ${PACK_MAX_SESSIONS}`),
  /** '' = any service. */
  serviceId: z.string(),
  /** '' = no expiry. */
  expiresOn: z.string().refine((v) => v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v), 'Fecha no válida'),
});
type Values = z.infer<typeof schema>;

/** F26: new pack of a client, or edit one (never below the sessions already used). */
export function PackDialog({
  open,
  onOpenChange,
  clientId,
  pack,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clientId: string;
  pack?: PackItem;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const services = useQuery({ ...trpc.services.list.queryOptions(), enabled: open });
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { name: defaultPackName(10), totalSessions: 10, serviceId: '', expiresOn: '' },
  });

  useEffect(() => {
    if (open) {
      form.reset(
        pack
          ? { name: pack.name, totalSessions: pack.totalSessions, serviceId: pack.serviceId ?? '', expiresOn: pack.expiresOn ?? '' }
          : { name: defaultPackName(10), totalSessions: 10, serviceId: '', expiresOn: '' },
      );
    }
  }, [open, pack, form]);

  const { errors, dirtyFields } = form.formState;
  // The default name follows the number of sessions until the name is typed by hand (dirty: `setValue` does not
  // mark it). Comparing it with the current number failed once the field had been emptied (NaN).
  const onSessionsChange = (value: number) => {
    if (!pack && !dirtyFields.name && Number.isInteger(value) && value > 0) form.setValue('name', defaultPackName(value));
  };

  const used = pack?.used ?? 0;
  const close = () => onOpenChange(false);
  const onDone = (message: string) => {
    toast.success(message);
    void queryClient.invalidateQueries({ queryKey: trpc.packs.pathKey() });
    close();
  };
  const create = useMutation(trpc.packs.create.mutationOptions({ onSuccess: () => onDone('Bono creado'), onError: (e) => toast.error(errorMessage(e)) }));
  const update = useMutation(trpc.packs.update.mutationOptions({ onSuccess: () => onDone('Bono actualizado'), onError: (e) => toast.error(errorMessage(e)) }));

  const onSubmit = (values: Values) => {
    if (values.totalSessions < used) {
      form.setError('totalSessions', { message: `Ya se han usado ${used}: no puede tener menos` });
      return;
    }
    const fields = {
      name: values.name.trim(),
      totalSessions: values.totalSessions,
      serviceId: values.serviceId || null,
      expiresOn: values.expiresOn || null,
    };
    if (pack) update.mutate({ ...fields, id: pack.id });
    else create.mutate({ ...fields, clientId });
  };

  const pending = create.isPending || update.isPending;
  const serviceOptions = (services.data ?? []).filter((s) => s.active || s.id === pack?.serviceId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby="pack-dialog-description">
        <DialogHeader>
          <DialogTitle>{pack ? 'Editar bono' : 'Nuevo bono'}</DialogTitle>
          <DialogDescription id="pack-dialog-description">
            Se descuenta una sesión cada vez que se marca «Asistió» en una cita del cliente.
          </DialogDescription>
        </DialogHeader>
        <form id="pack-form" className="grid gap-4" onSubmit={form.handleSubmit(onSubmit)} noValidate>
          <Field
            label="Sesiones"
            htmlFor="pack-sessions"
            required
            hint={used > 0 ? `Ya se han usado ${used}.` : undefined}
            error={errors.totalSessions?.message}
          >
            <Input
              id="pack-sessions"
              type="number"
              min={Math.max(1, used)}
              max={PACK_MAX_SESSIONS}
              aria-invalid={!!errors.totalSessions}
              {...form.register('totalSessions', { valueAsNumber: true, onChange: (e) => onSessionsChange(Number(e.target.value)) })}
            />
          </Field>
          <Field label="Nombre" htmlFor="pack-name" required error={errors.name?.message}>
            <Input id="pack-name" maxLength={PACK_NAME_MAX} aria-invalid={!!errors.name} {...form.register('name')} />
          </Field>
          <Field
            label="Servicio"
            htmlFor="pack-service"
            hint={used > 0 ? 'No se puede cambiar: el bono ya tiene sesiones usadas.' : 'Sin servicio, vale para cualquier cita.'}
          >
            <NativeSelect key={`pack-services-${serviceOptions.length}`} id="pack-service" disabled={used > 0} {...form.register('serviceId')}>
              <option value="">Cualquier servicio</option>
              {serviceOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Válido hasta" htmlFor="pack-expires" hint="Opcional: el último día en que se puede usar." error={errors.expiresOn?.message}>
            <Input id="pack-expires" type="date" aria-invalid={!!errors.expiresOn} {...form.register('expiresOn')} />
          </Field>
        </form>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Cancelar
            </Button>
          </DialogClose>
          <Button type="submit" form="pack-form" disabled={pending}>
            {pending ? 'Guardando…' : pack ? 'Guardar bono' : 'Crear bono'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
