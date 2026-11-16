'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MailIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { MEMBER_ROLE_LABELS_ES, type InvitableRole, type MemberRoleValue } from '@clinicai/shared';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, Input, NativeSelect } from '@/components/ui/form-controls';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from '@/components/ui/misc';
import { errorMessage } from '@/lib/utils';
import { useTRPC } from '@/trpc/react';

const roleLabel = (role: MemberRoleValue, employee: { name: string } | null) =>
  employee ? `${MEMBER_ROLE_LABELS_ES[role]} · ${employee.name}` : MEMBER_ROLE_LABELS_ES[role];

/** F18: who can use the panel. Professionals only see their own appointments. */
export function TeamCard() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const team = useQuery(trpc.team.list.queryOptions());
  const employees = useQuery(trpc.employees.list.queryOptions({}));
  const [form, setForm] = useState<{ email: string; role: InvitableRole; employeeId: string }>({
    email: '',
    role: 'professional',
    employeeId: '',
  });
  const [removing, setRemoving] = useState<{ kind: 'member' | 'invitation'; id: string; label: string } | null>(null);
  // F21: change the role of a member (administrator ↔ professional).
  const [changing, setChanging] = useState<{ id: string; email: string; role: InvitableRole; employeeId: string } | null>(null);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: trpc.team.pathKey() });
  const invite = useMutation(
    trpc.team.invite.mutationOptions({
      onSuccess: () => {
        toast.success('Invitación creada. Pídele que entre en el panel con ese email.');
        setForm((f) => ({ ...f, email: '', employeeId: '' }));
        refresh();
      },
      onError: (e) => toast.error(errorMessage(e)),
    }),
  );
  const done = (message: string) => ({
    onSuccess: () => {
      toast.success(message);
      setRemoving(null);
      refresh();
    },
    onError: (e: unknown) => toast.error(errorMessage(e)),
  });
  const remove = useMutation(trpc.team.remove.mutationOptions(done('Usuario quitado del equipo')));
  const changeRole = useMutation(
    trpc.team.changeRole.mutationOptions({
      onSuccess: () => {
        toast.success('Rol cambiado. Se aplica en su próxima acción en el panel.');
        setChanging(null);
        refresh();
      },
      onError: (e) => toast.error(errorMessage(e)),
    }),
  );
  const cancel = useMutation(trpc.team.cancelInvitation.mutationOptions(done('Invitación cancelada')));

  const members = team.data?.members ?? [];
  const invitations = team.data?.invitations ?? [];
  // A professional can have one user: those already linked (or invited) are not offered.
  const taken = new Set([...members, ...invitations.filter((i) => !i.expired)].map((x) => x.employee?.id).filter(Boolean));
  const freeEmployees = (employees.data ?? []).filter((e) => e.active && !taken.has(e.id));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Equipo</CardTitle>
        <CardDescription>
          Quién puede entrar en este panel. Los administradores ven y gestionan toda la clínica; cada profesional solo ve y
          gestiona sus propias citas.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        {team.isLoading ? (
          <Skeleton className="h-24" />
        ) : (
          <ul className="divide-y rounded-md border" aria-label="Usuarios del panel">
            {members.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <span className="min-w-48 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {m.email ?? 'Sin email'}
                    {m.isYou ? <span className="font-normal text-muted-foreground"> (tú)</span> : null}
                  </span>
                  <span className="block text-xs text-muted-foreground">{roleLabel(m.role, m.employee)}</span>
                </span>
                {m.role !== 'owner' && !m.isYou ? (
                  <span className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setChanging({
                          id: m.id,
                          email: m.email ?? 'este usuario',
                          role: m.role === 'professional' ? 'professional' : 'admin',
                          employeeId: m.employee?.id ?? '',
                        })
                      }
                    >
                      Cambiar rol
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setRemoving({ kind: 'member', id: m.id, label: m.email ?? 'este usuario' })}
                    >
                      Quitar
                    </Button>
                  </span>
                ) : null}
              </li>
            ))}
            {invitations.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <span className="min-w-48 flex-1">
                  <span className="block truncate text-sm font-medium">{i.email}</span>
                  <span className="block text-xs text-muted-foreground">{roleLabel(i.role, i.employee)}</span>
                </span>
                {i.expired ? (
                  // F34: after 14 days it cannot be taken; inviting the same email again replaces it.
                  <Badge variant="cancelled" className="gap-1" title="Invita de nuevo al mismo email para renovarla">
                    <MailIcon className="size-3" aria-hidden /> Invitación caducada
                  </Badge>
                ) : (
                  <Badge variant="muted" className="gap-1">
                    <MailIcon className="size-3" aria-hidden /> Invitación pendiente
                  </Badge>
                )}
                <Button variant="ghost" size="sm" onClick={() => setRemoving({ kind: 'invitation', id: i.id, label: i.email })}>
                  Cancelar
                </Button>
              </li>
            ))}
          </ul>
        )}

        <form
          className="grid gap-4 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end"
          aria-label="Invitar a alguien"
          onSubmit={(e) => {
            e.preventDefault();
            invite.mutate({ email: form.email, role: form.role, employeeId: form.role === 'professional' ? form.employeeId || null : null });
          }}
        >
          <Field label="Email" htmlFor="invite-email">
            <Input
              id="invite-email"
              type="email"
              autoComplete="off"
              placeholder="nombre@clinica.es"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              required
            />
          </Field>
          <Field label="Rol" htmlFor="invite-role">
            <NativeSelect id="invite-role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as InvitableRole })}>
              <option value="professional">Profesional</option>
              <option value="admin">Administrador</option>
            </NativeSelect>
          </Field>
          {form.role === 'professional' ? (
            <Field label="Profesional" htmlFor="invite-employee">
              <NativeSelect
                id="invite-employee"
                value={form.employeeId}
                onChange={(e) => setForm({ ...form, employeeId: e.target.value })}
                required
              >
                <option value="">{freeEmployees.length ? 'Elige…' : 'Todos tienen usuario'}</option>
                {freeEmployees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          ) : null}
          <Button type="submit" disabled={invite.isPending}>
            {invite.isPending ? 'Invitando…' : 'Invitar'}
          </Button>
        </form>
        <p className="text-xs text-muted-foreground">
          No se envía ningún correo: avisa a la persona para que entre en este panel con ese mismo email (recibirá un código
          para iniciar sesión). Al entrar se une a la clínica con el rol elegido. Si ya usa ClinicAI con otra clínica, no
          podrá unirse a esta.
        </p>
      </CardContent>
      <Dialog open={changing !== null} onOpenChange={(open) => !open && setChanging(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cambiar rol</DialogTitle>
            <DialogDescription>{changing?.email}. El cambio se aplica en su próxima acción en el panel.</DialogDescription>
          </DialogHeader>
          {changing ? (
            <form
              id="change-role-form"
              className="grid gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                changeRole.mutate({
                  id: changing.id,
                  role: changing.role,
                  employeeId: changing.role === 'professional' ? changing.employeeId || null : null,
                });
              }}
            >
              <Field label="Rol" htmlFor="change-role">
                <NativeSelect
                  id="change-role"
                  value={changing.role}
                  onChange={(e) => setChanging({ ...changing, role: e.target.value as InvitableRole })}
                >
                  <option value="professional">Profesional</option>
                  <option value="admin">Administrador</option>
                </NativeSelect>
              </Field>
              {changing.role === 'professional' ? (
                <Field label="Profesional" htmlFor="change-employee">
                  <NativeSelect
                    id="change-employee"
                    value={changing.employeeId}
                    onChange={(e) => setChanging({ ...changing, employeeId: e.target.value })}
                    required
                  >
                    <option value="">Elige…</option>
                    {(employees.data ?? [])
                      .filter((e) => e.id === changing.employeeId || (e.active && !taken.has(e.id)))
                      .map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.name}
                        </option>
                      ))}
                  </NativeSelect>
                </Field>
              ) : null}
            </form>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancelar
              </Button>
            </DialogClose>
            <Button type="submit" form="change-role-form" disabled={changeRole.isPending}>
              {changeRole.isPending ? 'Guardando…' : 'Guardar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={removing?.kind === 'invitation' ? 'Cancelar la invitación' : 'Quitar del equipo'}
        description={
          removing?.kind === 'invitation'
            ? `${removing.label} ya no podrá unirse a la clínica con esta invitación.`
            : `${removing?.label ?? ''} dejará de tener acceso a este panel.`
        }
        confirmLabel={removing?.kind === 'invitation' ? 'Cancelar invitación' : 'Quitar'}
        cancelLabel="Volver"
        pending={remove.isPending || cancel.isPending}
        onConfirm={() => {
          if (!removing) return;
          if (removing.kind === 'invitation') cancel.mutate({ id: removing.id });
          else remove.mutate({ id: removing.id });
        }}
      />
    </Card>
  );
}
