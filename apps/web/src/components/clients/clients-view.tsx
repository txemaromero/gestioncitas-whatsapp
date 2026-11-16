'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileUpIcon, PencilIcon, PlusIcon, SearchIcon, Trash2Icon } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/form-controls';
import { PageHeader, Skeleton, Table, TBody, TD, TH, THead, TR } from '@/components/ui/misc';
import { errorMessage } from '@/lib/utils';
import { useTRPC } from '@/trpc/react';
import { ClientDetail } from './client-detail';
import { ClientDialog, type ClientItem } from './client-dialog';
import { ImportClientsDialog } from './import-clients-dialog';

export function ClientsView() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [dialog, setDialog] = useState<{ open: boolean; client?: ClientItem }>({ open: false });
  const [detailId, setDetailId] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<ClientItem | null>(null);
  const [importing, setImporting] = useState(false);

  const clients = useQuery(trpc.clients.list.queryOptions({ search: deferredSearch }));
  const future = useQuery({
    ...trpc.clients.futureAppointments.queryOptions({ id: toDelete?.id ?? '00000000-0000-4000-8000-000000000000' }),
    enabled: toDelete !== null,
  });
  const remove = useMutation(
    trpc.clients.delete.mutationOptions({
      onSuccess: () => {
        toast.success('Cliente y todos sus datos eliminados');
        setToDelete(null);
        void queryClient.invalidateQueries({ queryKey: trpc.clients.pathKey() });
        void queryClient.invalidateQueries({ queryKey: trpc.appointments.pathKey() });
      },
      onError: (e) => toast.error(errorMessage(e)),
    }),
  );
  const futureCount = future.data ?? 0;

  return (
    <>
      <PageHeader
        title="Gestión de Clientes"
        description="Pacientes registrados por WhatsApp o desde el panel."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setImporting(true)}>
              <FileUpIcon /> Importar CSV
            </Button>
            <Button onClick={() => setDialog({ open: true })}>
              <PlusIcon /> Nuevo Cliente
            </Button>
          </div>
        }
      />
      <div className="relative mb-4 max-w-sm">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-9"
          placeholder="Buscar clientes..."
          aria-label="Buscar clientes"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <Table>
        <THead>
          <TR>
            <TH>Nombre</TH>
            <TH>Email</TH>
            <TH>Teléfono</TH>
            <TH className="w-24 text-right">Acciones</TH>
          </TR>
        </THead>
        <TBody>
          {clients.isLoading ? (
            <TR>
              <TD colSpan={4}>
                <Skeleton className="h-8" />
              </TD>
            </TR>
          ) : (clients.data ?? []).length === 0 ? (
            <TR>
              <TD colSpan={4} className="py-8 text-center text-muted-foreground">
                No hay clientes{search ? ' que coincidan con la búsqueda' : ''}.
              </TD>
            </TR>
          ) : (
            (clients.data ?? []).map((c) => (
              <TR key={c.id}>
                <TD className="font-medium">
                  <button type="button" className="text-left hover:text-primary hover:underline" onClick={() => setDetailId(c.id)}>
                    {c.name}
                  </button>
                </TD>
                <TD className="text-muted-foreground">{c.email ?? '-'}</TD>
                <TD className="whitespace-nowrap text-muted-foreground">{c.phone ?? '-'}</TD>
                <TD className="text-right whitespace-nowrap">
                  <Button variant="ghost" size="icon" aria-label={`Editar ${c.name}`} onClick={() => setDialog({ open: true, client: c })}>
                    <PencilIcon />
                  </Button>
                  <Button variant="ghost" size="icon" aria-label={`Eliminar ${c.name}`} onClick={() => setToDelete(c)}>
                    <Trash2Icon className="text-destructive" />
                  </Button>
                </TD>
              </TR>
            ))
          )}
        </TBody>
      </Table>

      <ClientDialog open={dialog.open} client={dialog.client} onOpenChange={(open) => setDialog((d) => ({ ...d, open }))} />
      <ImportClientsDialog open={importing} onOpenChange={setImporting} />
      <ClientDetail clientId={detailId} onOpenChange={(open) => !open && setDetailId(null)} />
      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open) => !open && setToDelete(null)}
        title={`¿Eliminar a ${toDelete?.name ?? ''}?`}
        description={`${
          futureCount > 0 ? `Atención: tiene ${futureCount} cita(s) futura(s), que también se eliminarán. ` : ''
        }Se borrarán todos sus datos: la ficha, el historial de citas, su conversación con el bot y, si usas Chatwoot, su contacto y sus conversaciones allí. Si lo necesitas, exporta antes sus datos desde su ficha. Esta acción no se puede deshacer.`}
        pending={remove.isPending}
        onConfirm={() => toDelete && remove.mutate({ id: toDelete.id })}
      />
    </>
  );
}
