'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRingIcon, HourglassIcon, PlusIcon } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { formatHumanDate, formatTime } from '@clinicai/shared';
import { useTenant } from '@/components/layout/tenant-context';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from '@/components/ui/misc';
import { errorMessage, REFRESH_MS } from '@/lib/utils';
import { useTRPC } from '@/trpc/react';
import { AddToWaitlistDialog } from './add-to-waitlist-dialog';

/** F17: clients waiting for a freed slot, oldest first within each day. */
export function WaitlistCard() {
  const trpc = useTRPC();
  const tenant = useTenant();
  const queryClient = useQueryClient();
  const list = useQuery({ ...trpc.waitlist.list.queryOptions(), refetchInterval: REFRESH_MS });
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const remove = useMutation(
    trpc.waitlist.remove.mutationOptions({
      onSuccess: () => {
        toast.success('Quitado de la lista de espera');
        setRemoving(null);
        void queryClient.invalidateQueries({ queryKey: trpc.waitlist.pathKey() });
      },
      onError: (e) => toast.error(errorMessage(e)),
    }),
  );

  const entries = list.data?.entries ?? [];
  // Hidden while the feature is off and nobody is waiting.
  if (list.isSuccess && !list.data.enabled && entries.length === 0) return null;
  const tz = tenant.timezone;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <CardTitle>Lista de espera</CardTitle>
          {list.data?.enabled ? (
            <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
              <PlusIcon /> Añadir
            </Button>
          ) : null}
        </div>
        <CardDescription>
          Clientes que esperan un hueco. Cuando se libera uno, el bot avisa por WhatsApp al primero de la lista.
          {list.data && !list.data.enabled ? (
            <>
              {' '}
              La lista de espera está desactivada en{' '}
              <Link href="/settings" className="font-medium text-primary hover:underline">
                Ajustes
              </Link>
              : no se enviarán avisos.
            </>
          ) : null}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {list.isLoading ? (
          <Skeleton className="h-20" />
        ) : entries.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <HourglassIcon className="size-4" /> Nadie está esperando un hueco.
          </p>
        ) : (
          <ul className="divide-y" aria-label="Clientes en lista de espera">
            {entries.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="min-w-48 flex-1">
                  <span className="block truncate text-sm font-medium">{e.clientName}</span>
                  <span className="block text-xs text-muted-foreground">
                    {formatHumanDate(e.windowStart, tz)} · {e.wholeDay ? 'cualquier hora' : formatTime(e.windowStart, tz)}
                    {e.serviceName ? ` · ${e.serviceName}` : ''}
                  </span>
                </span>
                {e.offer ? (
                  <Badge variant="muted" className="gap-1">
                    <BellRingIcon className="size-3" aria-hidden />
                    Avisado: {formatTime(e.offer.start, tz)} (responde hasta las {formatTime(e.offer.expiresAt, tz)})
                  </Badge>
                ) : null}
                <Button variant="ghost" size="sm" onClick={() => setRemoving({ id: e.id, name: e.clientName })}>
                  Quitar
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <AddToWaitlistDialog open={adding} onOpenChange={setAdding} />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title="Quitar de la lista de espera"
        description={removing ? `${removing.name} dejará de recibir avisos de huecos libres para ese día.` : undefined}
        confirmLabel="Quitar"
        pending={remove.isPending}
        onConfirm={() => removing && remove.mutate({ id: removing.id })}
      />
    </Card>
  );
}
