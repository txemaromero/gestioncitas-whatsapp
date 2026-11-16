'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { EMPLOYEE_ROLES, validateSchedule, type ScheduleSlot } from '@clinicai/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, Input, NativeSelect } from '@/components/ui/form-controls';
import { errorMessage } from '@/lib/utils';
import type { RouterOutputs } from '@/server/routers/_app';
import { useTRPC } from '@/trpc/react';
import { ScheduleEditor } from './schedule-editor';

export type EmployeeItem = RouterOutputs['employees']['list'][number];

export function EmployeeDialog({
  open,
  onOpenChange,
  employee,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employee?: EmployeeItem;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{employee ? 'Editar Empleado' : 'Nuevo Empleado'}</DialogTitle>
          <DialogDescription>Los empleados activos con horario aparecen en la selección del bot de WhatsApp.</DialogDescription>
        </DialogHeader>
        {/* Mounted per opening: the form state is initialized from the employee, no syncing effects. */}
        {open ? <EmployeeForm key={employee?.id ?? 'new'} employee={employee} onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function EmployeeForm({ employee, onDone }: { employee: EmployeeItem | undefined; onDone: () => void }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [name, setName] = useState(employee?.name ?? '');
  const [role, setRole] = useState<string>(employee?.role ?? 'fisioterapeuta');
  const [schedule, setSchedule] = useState<ScheduleSlot[]>(employee?.schedule ?? []);
  const [errors, setErrors] = useState<{ name?: string; role?: string; schedule: Record<number, string> }>({ schedule: {} });

  const onSuccess = (message: string) => {
    toast.success(message);
    void queryClient.invalidateQueries({ queryKey: trpc.employees.pathKey() });
    onDone();
  };
  const create = useMutation(
    trpc.employees.create.mutationOptions({ onSuccess: () => onSuccess('Empleado creado'), onError: (e) => toast.error(errorMessage(e)) }),
  );
  const update = useMutation(
    trpc.employees.update.mutationOptions({ onSuccess: () => onSuccess('Cambios guardados'), onError: (e) => toast.error(errorMessage(e)) }),
  );

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const next: typeof errors = { schedule: {} };
    if (name.trim().length < 2) next.name = 'El nombre es obligatorio (mínimo 2 caracteres)';
    if (role.trim().length < 2) next.role = 'Selecciona un rol';
    for (const issue of validateSchedule(schedule)) next.schedule[issue.index] = issue.message;
    setErrors(next);
    if (next.name || next.role || Object.keys(next.schedule).length > 0) return;
    const payload = { name: name.trim(), role, schedule };
    if (employee) update.mutate({ ...payload, id: employee.id });
    else create.mutate(payload);
  };

  const roles: string[] = [...EMPLOYEE_ROLES];
  if (employee && !roles.includes(employee.role)) roles.push(employee.role);
  const pending = create.isPending || update.isPending;

  return (
    <>
      <form id="employee-form" className="grid gap-4" onSubmit={submit} noValidate>
        <Field label="Nombre" htmlFor="employee-name" required error={errors.name}>
          <Input id="employee-name" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!errors.name} />
        </Field>
        <Field label="Rol" htmlFor="employee-role" required error={errors.role}>
          <NativeSelect id="employee-role" value={role} onChange={(e) => setRole(e.target.value)}>
            {roles.map((r) => (
              <option key={r} value={r}>
                {r.charAt(0).toUpperCase() + r.slice(1)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Horario (opcional)">
          <ScheduleEditor value={schedule} onChange={setSchedule} errors={errors.schedule} />
        </Field>
      </form>
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancelar
          </Button>
        </DialogClose>
        <Button type="submit" form="employee-form" disabled={pending}>
          {pending ? 'Guardando…' : 'Guardar Cambios'}
        </Button>
      </DialogFooter>
    </>
  );
}
