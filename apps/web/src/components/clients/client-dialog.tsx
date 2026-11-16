'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { isValidEmail, normalizePhone } from '@clinicai/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/form-controls';
import { errorMessage } from '@/lib/utils';
import type { RouterOutputs } from '@/server/routers/_app';
import { useTRPC } from '@/trpc/react';

export type ClientItem = RouterOutputs['clients']['list'][number];

const schema = z.object({
  name: z.string().trim().min(2, 'El nombre es obligatorio (mínimo 2 caracteres)').max(80),
  email: z.string().trim().max(254).refine((v) => v === '' || isValidEmail(v), 'Email no válido'),
  phone: z.string().trim().max(30).refine((v) => v === '' || normalizePhone(v) !== null, 'Teléfono no válido'),
  notes: z.string().trim().max(2000),
  consent: z.boolean(),
});
type Values = z.infer<typeof schema>;

export function ClientDialog({ open, onOpenChange, client }: { open: boolean; onOpenChange: (open: boolean) => void; client?: ClientItem }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', email: '', phone: '', notes: '', consent: false },
  });

  useEffect(() => {
    if (open) {
      form.reset({
        name: client?.name ?? '',
        email: client?.email ?? '',
        phone: client?.phone ?? '',
        notes: client?.notes ?? '',
        consent: Boolean(client?.consentAt),
      });
    }
  }, [open, client, form]);

  const onSuccess = (message: string) => {
    toast.success(message);
    void queryClient.invalidateQueries({ queryKey: trpc.clients.pathKey() });
    void queryClient.invalidateQueries({ queryKey: trpc.appointments.pathKey() });
    onOpenChange(false);
  };
  const onError = (error: unknown) => {
    const message = errorMessage(error);
    if (/teléfono/i.test(message)) form.setError('phone', { message });
    toast.error(message);
  };
  const create = useMutation(trpc.clients.create.mutationOptions({ onSuccess: () => onSuccess('Cliente creado'), onError }));
  const update = useMutation(trpc.clients.update.mutationOptions({ onSuccess: () => onSuccess('Cambios guardados'), onError }));

  const submit = (values: Values) => {
    if (client) update.mutate({ ...values, id: client.id });
    else create.mutate(values);
  };
  const { errors } = form.formState;
  const pending = create.isPending || update.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{client ? 'Editar Cliente' : 'Nuevo Cliente'}</DialogTitle>
          <DialogDescription>El teléfono identifica al cliente cuando escribe por WhatsApp.</DialogDescription>
        </DialogHeader>
        <form id="client-form" className="grid gap-4" onSubmit={form.handleSubmit(submit)} noValidate>
          <Field label="Nombre" htmlFor="client-name" required error={errors.name?.message}>
            <Input id="client-name" aria-invalid={!!errors.name} {...form.register('name')} />
          </Field>
          <Field label="Email" htmlFor="client-email" error={errors.email?.message}>
            <Input id="client-email" type="email" placeholder="nombre@gmail.com" aria-invalid={!!errors.email} {...form.register('email')} />
          </Field>
          <Field label="Teléfono" htmlFor="client-phone" hint="Se guarda en formato internacional; por defecto +34." error={errors.phone?.message}>
            <Input id="client-phone" inputMode="tel" placeholder="+34 600 000 000" aria-invalid={!!errors.phone} {...form.register('phone')} />
          </Field>
          <Field label="Notas" htmlFor="client-notes">
            <Textarea id="client-notes" rows={3} {...form.register('notes')} />
          </Field>
          <div className="grid gap-1.5">
            <label htmlFor="client-consent" className="flex items-start gap-2 text-sm font-medium">
              <input id="client-consent" type="checkbox" className="mt-0.5 size-4 accent-primary" {...form.register('consent')} />
              Ha aceptado la política de privacidad (por ejemplo, firmada en la clínica)
            </label>
            <p className="text-xs text-muted-foreground">
              Si no la ha aceptado, el bot le mostrará el aviso de privacidad y le pedirá que lo acepte en su primer mensaje de WhatsApp.
            </p>
          </div>
        </form>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Cancelar
            </Button>
          </DialogClose>
          <Button type="submit" form="client-form" disabled={pending}>
            {pending ? 'Guardando…' : client ? 'Guardar Cambios' : 'Crear Cliente'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
