'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarOffIcon, PencilIcon, PlusIcon, SearchIcon, Trash2Icon } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { toast } from 'sonner';
import { employeeColor, formatScheduleEs } from '@clinicai/shared';
import { Button } from '@/components/ui/button';
import { TimeOffPanel } from '@/components/time-off/time-off-panel';
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/form-controls';
import { Badge, PageHeader, Skeleton, Table, TBody, TD, TH, THead, TR } from '@/components/ui/misc';
import { errorMessage } from '@/lib/utils';
import { useTRPC } from '@/trpc/react';
import { EmployeeDialog, type EmployeeItem } from './employee-dialog';

export function EmployeesView() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [dialog, setDialog] = useState<{ open: boolean; employee?: EmployeeItem }>({ open: false });
  const [absences, setAbsences] = useState<EmployeeItem | null>(null);
  const [toDelete, setToDelete] = useState<EmployeeItem | null>(null);

  const employees = useQuery(trpc.employees.list.queryOptions({ search: deferredSearch }));
  const future = useQuery({
    ...trpc.employees.futureAppointments.queryOptions({ id: toDelete?.id ?? '00000000-0000-4000-8000-000000000000' }),
    enabled: toDelete !== null,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.employees.pathKey() });
  const remove = useMutation(
    trpc.employees.delete.mutationOptions({
      onSuccess: () => {
        toast.success('Empleado eliminado');
        setToDelete(null);
        void refresh();
        void queryClient.invalidateQueries({ queryKey: trpc.appointments.pathKey() });
      },
      onError: (e) => toast.error(errorMessage(e)),
    }),
  );
  const setActive = useMutation(
    trpc.employees.setActive.mutationOptions({
      onSuccess: (employee) => {
        toast.success(employee.active ? 'Empleado activado' : 'Empleado desactivado: ya no aparecerá en el bot');
        setToDelete(null);
        void refresh();
      },
      onError: (e) => toast.error(errorMessage(e)),
    }),
  );

  const futureCount = future.data ?? 0;

  return (
    <>
      <PageHeader
        title="Gestión de Empleados"
        description="Profesionales de la clínica y su horario semanal."
        actions={
          <Button onClick={() => setDialog({ open: true })}>
            <PlusIcon /> Nuevo Empleado
          </Button>
        }
      />
      <div className="relative mb-4 max-w-sm">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-9"
          placeholder="Buscar empleados..."
          aria-label="Buscar empleados"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <Table>
        <THead>
          <TR>
            <TH>Nombre</TH>
            <TH>Rol</TH>
            <TH>Horario</TH>
            <TH className="w-24 text-right">Acciones</TH>
          </TR>
        </THead>
        <TBody>
          {employees.isLoading ? (
            <TR>
              <TD colSpan={4}>
                <Skeleton className="h-8" />
              </TD>
            </TR>
          ) : (employees.data ?? []).length === 0 ? (
            <TR>
              <TD colSpan={4} className="py-8 text-center text-muted-foreground">
                No hay empleados{search ? ' que coincidan con la búsqueda' : ''}.
              </TD>
            </TR>
          ) : (
            (employees.data ?? []).map((e) => (
              <TR key={e.id}>
                <TD className="font-medium">
                  <span className="flex items-center gap-2">
                    <span className="size-2.5 rounded-full" style={{ backgroundColor: employeeColor(e.id) }} />
                    {e.name}
                    {!e.active ? <Badge variant="muted">Inactivo</Badge> : null}
                  </span>
                </TD>
                <TD className="first-letter:uppercase">{e.role}</TD>
                <TD className="max-w-md text-muted-foreground">{formatScheduleEs(e.schedule)}</TD>
                <TD className="text-right whitespace-nowrap">
                  <Button variant="ghost" size="icon" aria-label={`Ausencias de ${e.name}`} title="Ausencias" onClick={() => setAbsences(e)}>
                    <CalendarOffIcon />
                  </Button>
                  <Button variant="ghost" size="icon" aria-label={`Editar ${e.name}`} onClick={() => setDialog({ open: true, employee: e })}>
                    <PencilIcon />
                  </Button>
                  <Button variant="ghost" size="icon" aria-label={`Eliminar ${e.name}`} onClick={() => setToDelete(e)}>
                    <Trash2Icon className="text-destructive" />
                  </Button>
                </TD>
              </TR>
            ))
          )}
        </TBody>
      </Table>

      <EmployeeDialog
        open={dialog.open}
        employee={dialog.employee}
        onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
      />

      <Dialog open={absences !== null} onOpenChange={(open) => !open && setAbsences(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Ausencias de {absences?.name ?? ''}</DialogTitle>
            <DialogDescription>
              Vacaciones, bajas o permisos. En ese tiempo nadie puede reservar con este profesional, ni por WhatsApp ni desde el
              calendario. Los festivos de toda la clínica se gestionan en Ajustes.
            </DialogDescription>
          </DialogHeader>
          {absences ? <TimeOffPanel key={absences.id} employeeId={absences.id} reasonPlaceholder="Vacaciones, formación, baja…" /> : null}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open) => !open && setToDelete(null)}
        title={`¿Eliminar a ${toDelete?.name ?? ''}?`}
        description={
          futureCount > 0
            ? `Tiene ${futureCount} cita(s) futura(s), que también se eliminarán. Puedes desactivarlo en su lugar: dejará de aparecer en el bot y conservarás sus citas.`
            : 'Esta acción no se puede deshacer.'
        }
        confirmLabel={futureCount > 0 ? 'Eliminar igualmente' : 'Eliminar'}
        pending={remove.isPending}
        onConfirm={() => toDelete && remove.mutate({ id: toDelete.id, force: true })}
      >
        {futureCount > 0 && toDelete?.active ? (
          <Button
            variant="dark"
            disabled={setActive.isPending}
            onClick={() => toDelete && setActive.mutate({ id: toDelete.id, active: false })}
          >
            Desactivar en su lugar
          </Button>
        ) : null}
      </ConfirmDialog>
    </>
  );
}
