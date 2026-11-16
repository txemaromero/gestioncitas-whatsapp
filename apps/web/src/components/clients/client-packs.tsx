'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PencilIcon, PlusIcon, TicketIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { formatEsShort, PACK_STATE_LABELS_ES } from '@clinicai/shared';
import { useTenant } from '@/components/layout/tenant-context';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Badge, Skeleton } from '@/components/ui/misc';
import { errorMessage } from '@/lib/utils';
import { useTRPC } from '@/trpc/react';
import { PackDialog, type PackItem } from './pack-dialog';

/** `2027-03-31` → `31/03/2027`. */
const dayKey = (key: string) => key.split('-').reverse().join('/');

/** F26: packs (bonos) of a client in their record: sessions used, expiry and where they went. */
export function ClientPacks({ clientId }: { clientId: string }) {
  const trpc = useTRPC();
  const tenant = useTenant();
  const queryClient = useQueryClient();
  const packs = useQuery(trpc.packs.list.queryOptions({ clientId }));
  const [dialog, setDialog] = useState<{ open: boolean; pack?: PackItem }>({ open: false });
  const [deleting, setDeleting] = useState<PackItem | null>(null);
  const remove = useMutation(
    trpc.packs.delete.mutationOptions({
      onSuccess: () => {
        toast.success('Bono borrado');
        setDeleting(null);
        void queryClient.invalidateQueries({ queryKey: trpc.packs.pathKey() });
      },
      onError: (e) => toast.error(errorMessage(e)),
    }),
  );

  return (
    <section className="grid gap-2" aria-labelledby="client-packs-title">
      <div className="flex items-center justify-between gap-2">
        <h3 id="client-packs-title" className="flex items-center gap-2 text-sm font-semibold">
          <TicketIcon className="size-4 text-muted-foreground" aria-hidden="true" /> Bonos
        </h3>
        <Button type="button" variant="outline" size="sm" onClick={() => setDialog({ open: true })}>
          <PlusIcon /> Nuevo bono
        </Button>
      </div>
      {packs.isLoading ? (
        <Skeleton className="h-16" />
      ) : (packs.data ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground">Sin bonos.</p>
      ) : (
        <ul className="grid gap-2">
          {(packs.data ?? []).map((p) => (
            <li key={p.id} className="grid gap-2 rounded-lg border p-3">
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{p.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {p.serviceName ?? 'Cualquier servicio'}
                    {p.expiresOn ? ` · hasta el ${dayKey(p.expiresOn)}` : ''}
                  </span>
                </span>
                <Badge variant={p.state === 'active' ? 'confirmed' : 'muted'}>{PACK_STATE_LABELS_ES[p.state]}</Badge>
              </div>
              <div className="grid gap-1">
                <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, (p.used / p.totalSessions) * 100)}%` }} />
                </div>
                <p className="text-xs text-muted-foreground">
                  {p.used} de {p.totalSessions} sesiones usadas · {p.remaining === 1 ? 'queda 1' : `quedan ${p.remaining}`}
                </p>
              </div>
              {p.sessions.length > 0 ? (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">Citas en las que se usó</summary>
                  <ul className="mt-1 grid gap-0.5">
                    {p.sessions.map((s) => (
                      <li key={s.id}>
                        {formatEsShort(s.date, tenant.timezone)}
                        {s.attendance === 'no_show' ? ' (no se presentó)' : ''}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
              <div className="flex gap-1">
                <Button type="button" variant="ghost" size="sm" onClick={() => setDialog({ open: true, pack: p })} aria-label={`Editar ${p.name}`}>
                  <PencilIcon /> Editar
                </Button>
                {p.used === 0 ? (
                  <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={() => setDeleting(p)} aria-label={`Borrar ${p.name}`}>
                    <Trash2Icon /> Borrar
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      <PackDialog open={dialog.open} onOpenChange={(open) => setDialog({ open })} clientId={clientId} {...(dialog.pack ? { pack: dialog.pack } : {})} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="¿Borrar el bono?"
        description={deleting ? `Se borrará «${deleting.name}». No tiene sesiones usadas.` : undefined}
        confirmLabel="Borrar bono"
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate({ id: deleting.id })}
      />
    </section>
  );
}
