'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarPlusIcon, CopyIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { formatHumanDateTime } from '@clinicai/shared';
import { useTenant } from '@/components/layout/tenant-context';
import { Button, buttonVariants } from '@/components/ui/button';
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, Input, NativeSelect } from '@/components/ui/form-controls';
import { Skeleton } from '@/components/ui/misc';
import { errorMessage } from '@/lib/utils';
import { useTRPC } from '@/trpc/react';

/**
 * F28: subscribe to a professional's agenda from Google, Apple or Outlook. A professional sees
 * their own; the owner and administrators choose whose.
 */
export function AgendaLinkDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const trpc = useTRPC();
  const tenant = useTenant();
  const queryClient = useQueryClient();
  const own = tenant.employeeId !== null;
  const [chosen, setChosen] = useState('');
  const [fullNames, setFullNames] = useState(false);
  const [confirm, setConfirm] = useState<'renew' | 'revoke' | null>(null);
  const employees = useQuery({ ...trpc.employees.list.queryOptions({}), enabled: open && !own });
  const target = own ? {} : chosen ? { employeeId: chosen } : null;
  const link = useQuery({ ...trpc.calendarFeed.get.queryOptions(target ?? {}), enabled: open && target !== null });
  const feed = link.data?.feed ?? null;

  const refresh = () => void queryClient.invalidateQueries({ queryKey: trpc.calendarFeed.pathKey() });
  const onError = (e: unknown) => toast.error(errorMessage(e));
  const create = useMutation(
    trpc.calendarFeed.create.mutationOptions({
      onSuccess: () => {
        toast.success(feed ? 'Enlace nuevo creado: el anterior ya no funciona' : 'Enlace creado');
        setConfirm(null);
        refresh();
      },
      onError,
    }),
  );
  const setNames = useMutation(trpc.calendarFeed.setFullNames.mutationOptions({ onSuccess: refresh, onError }));
  const revoke = useMutation(
    trpc.calendarFeed.revoke.mutationOptions({
      onSuccess: () => {
        toast.success('Enlace revocado');
        setConfirm(null);
        refresh();
      },
      onError,
    }),
  );
  const copy = (url: string) =>
    navigator.clipboard.writeText(url).then(
      () => toast.success('Enlace copiado'),
      () => toast.error('No se ha podido copiar: selecciónalo y cópialo a mano'),
    );

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent aria-describedby="agenda-link-description">
          <DialogHeader>
            <DialogTitle>Ver la agenda en el móvil</DialogTitle>
            <DialogDescription id="agenda-link-description">
              Suscríbete a la agenda desde Google Calendar, Apple Calendar u Outlook. Es de solo lectura: las citas se siguen gestionando
              aquí.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            {!own ? (
              <Field label="Profesional" htmlFor="agenda-employee">
                <NativeSelect id="agenda-employee" value={chosen} onChange={(e) => setChosen(e.target.value)}>
                  <option value="">Elige un profesional</option>
                  {(employees.data ?? [])
                    .filter((e) => e.active)
                    .map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                </NativeSelect>
              </Field>
            ) : null}

            {target === null ? null : link.isLoading ? (
              <Skeleton className="h-24" />
            ) : !feed ? (
              <div className="grid gap-3">
                <p className="text-sm text-muted-foreground">
                  {own ? 'Todavía no tienes enlace.' : `${link.data?.employee.name ?? 'Este profesional'} todavía no tiene enlace.`} Incluye
                  las citas desde hace 30 días hasta dentro de 6 meses, las ausencias y los cierres de la clínica.
                </p>
                <label htmlFor="agenda-full-names-new" className="flex items-start gap-2 text-sm">
                  <input
                    id="agenda-full-names-new"
                    type="checkbox"
                    className="mt-0.5 size-4 accent-primary"
                    checked={fullNames}
                    onChange={(e) => setFullNames(e.target.checked)}
                  />
                  Mostrar el nombre completo de los clientes (si no, solo sus iniciales)
                </label>
                <Button type="button" className="w-fit" disabled={create.isPending} onClick={() => create.mutate({ ...target, fullNames })}>
                  {create.isPending ? 'Creando…' : 'Crear enlace'}
                </Button>
              </div>
            ) : (
              <div className="grid gap-4">
                <Field label="Enlace" htmlFor="agenda-url">
                  <div className="flex gap-2">
                    <Input id="agenda-url" readOnly value={feed.url} className="font-mono text-xs" />
                    <Button type="button" variant="outline" onClick={() => void copy(feed.url)}>
                      <CopyIcon /> Copiar
                    </Button>
                  </div>
                </Field>
                <a href={feed.webcalUrl} className={buttonVariants({ variant: 'default', className: 'w-fit' })}>
                  <CalendarPlusIcon /> Añadir a Apple Calendar
                </a>
                <ul className="grid list-disc gap-1 pl-5 text-sm text-muted-foreground">
                  <li>iPhone o Mac: pulsa «Añadir a Apple Calendar».</li>
                  <li>Google Calendar: en el ordenador, «Otros calendarios» → «+» → «Desde URL», y pega el enlace. Aparecerá también en el móvil.</li>
                  <li>Outlook: «Añadir calendario» → «Suscribirse desde la web», y pega el enlace.</li>
                </ul>
                <label htmlFor="agenda-full-names" className="flex items-start gap-2 text-sm">
                  <input
                    id="agenda-full-names"
                    type="checkbox"
                    className="mt-0.5 size-4 accent-primary"
                    checked={feed.fullNames}
                    disabled={setNames.isPending}
                    onChange={(e) => setNames.mutate({ ...target, fullNames: e.target.checked })}
                  />
                  Mostrar el nombre completo de los clientes (si no, solo sus iniciales)
                </label>
                <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                  Cualquiera con el enlace puede ver esta agenda: no lo compartas. Las apps lo actualizan cada cierto tiempo (Google, cada
                  varias horas), así que los cambios no aparecen al instante.
                </p>
                <p className="text-xs text-muted-foreground">
                  Creado el {formatHumanDateTime(feed.createdAt, tenant.timezone)}. Último uso:{' '}
                  {feed.lastUsedAt ? formatHumanDateTime(feed.lastUsedAt, tenant.timezone) : 'todavía no'}.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => setConfirm('renew')}>
                    <RefreshCwIcon /> Crear enlace nuevo
                  </Button>
                  <Button type="button" variant="outline" size="sm" className="text-destructive" onClick={() => setConfirm('revoke')}>
                    <Trash2Icon /> Revocar enlace
                  </Button>
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(value) => !value && setConfirm(null)}
        title={confirm === 'renew' ? '¿Crear un enlace nuevo?' : '¿Revocar el enlace?'}
        description={
          confirm === 'renew'
            ? 'El enlace actual dejará de funcionar: habrá que suscribirse otra vez con el nuevo.'
            : 'El enlace dejará de funcionar y la agenda desaparecerá de los calendarios suscritos en su próxima actualización.'
        }
        confirmLabel={confirm === 'renew' ? 'Crear enlace nuevo' : 'Revocar enlace'}
        destructive={confirm === 'revoke'}
        pending={create.isPending || revoke.isPending}
        onConfirm={() => {
          if (!target) return;
          if (confirm === 'renew') create.mutate({ ...target, fullNames: feed?.fullNames ?? false });
          else revoke.mutate(target);
        }}
      />
    </>
  );
}
