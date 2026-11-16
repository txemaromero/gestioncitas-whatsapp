'use client';

import { LogoutLink } from '@kinde-oss/kinde-auth-nextjs/components';
import { useMutation } from '@tanstack/react-query';
import { BarChart3Icon, DoorOpenIcon, HistoryIcon, InfoIcon, LogOutIcon, SettingsIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Avatar, DropdownMenu } from 'radix-ui';
import { useState } from 'react';
import { isAdminRole, MEMBER_ROLE_LABELS_ES } from '@clinicai/shared';
import { toast } from 'sonner';
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { errorMessage } from '@/lib/utils';
import { useTRPC } from '@/trpc/react';
import { useTenant } from './tenant-context';

const itemClass =
  'flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground';

export function AccountMenu({
  clinicName,
  user,
  platformAdmin = false,
}: {
  clinicName: string;
  user: { name: string | null; email: string | null; picture: string | null };
  platformAdmin?: boolean;
}) {
  const [infoOpen, setInfoOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const { role, employeeName } = useTenant();
  const trpc = useTRPC();
  const router = useRouter();
  // F34: anyone but the owner can leave the clinic; then they can create their own or join another.
  const leave = useMutation(
    trpc.team.leave.mutationOptions({
      onSuccess: () => {
        router.push('/onboarding');
        router.refresh();
      },
      onError: (e) => toast.error(errorMessage(e)),
    }),
  );
  const roleText = employeeName ? `${MEMBER_ROLE_LABELS_ES[role]} · ${employeeName}` : MEMBER_ROLE_LABELS_ES[role];
  const initials = (user.name ?? user.email ?? '?')
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');

  return (
    <>
      {/* Not modal: the rest of the page stays visible to screen readers (aria-hidden would hide
          links that can still get focus). Escape or a click outside closes it. */}
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger className="rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
          {/* The name comes from this text, not an aria-label: the visible initials would not match it. */}
          <span className="sr-only">Menú de la cuenta</span>
          <Avatar.Root aria-hidden="true" className="flex size-9 overflow-hidden rounded-full bg-foreground text-background">
            {user.picture ? <Avatar.Image src={user.picture} alt="" className="size-full object-cover" /> : null}
            <Avatar.Fallback className="flex size-full items-center justify-center text-sm font-medium">{initials}</Avatar.Fallback>
          </Avatar.Root>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={8} className="z-50 min-w-56 rounded-md border bg-popover p-1 shadow-md">
            <div className="px-2 py-1.5">
              <p className="truncate text-sm font-medium">{user.name ?? 'Administrador'}</p>
              <p className="truncate text-xs text-muted-foreground">{user.email}</p>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">{roleText}</p>
            </div>
            <DropdownMenu.Separator className="my-1 h-px bg-border" />
            <DropdownMenu.Item className={itemClass} onSelect={() => setInfoOpen(true)}>
              <InfoIcon className="size-4" /> Información de la cuenta
            </DropdownMenu.Item>
            {isAdminRole(role) ? (
              <DropdownMenu.Item className={itemClass} asChild>
                <Link href="/settings">
                  <SettingsIcon className="size-4" /> Ajustes
                </Link>
              </DropdownMenu.Item>
            ) : null}
            {isAdminRole(role) ? (
              <DropdownMenu.Item className={itemClass} asChild>
                <Link href="/activity">
                  <HistoryIcon className="size-4" /> Registro de actividad
                </Link>
              </DropdownMenu.Item>
            ) : null}
            {platformAdmin ? (
              <DropdownMenu.Item className={itemClass} asChild>
                <Link href="/plataforma">
                  <BarChart3Icon className="size-4" /> Consola de la plataforma
                </Link>
              </DropdownMenu.Item>
            ) : null}
            <DropdownMenu.Separator className="my-1 h-px bg-border" />
            {role !== 'owner' ? (
              <DropdownMenu.Item className={itemClass} onSelect={() => setLeaveOpen(true)}>
                <DoorOpenIcon className="size-4" /> Salir de la clínica
              </DropdownMenu.Item>
            ) : null}
            <DropdownMenu.Item className={itemClass} asChild>
              <LogoutLink>
                <LogOutIcon className="size-4" /> Cerrar sesión
              </LogoutLink>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <ConfirmDialog
        open={leaveOpen}
        onOpenChange={setLeaveOpen}
        title="Salir de la clínica"
        description={`Dejarás de ver ${clinicName} en este panel. Para volver, un administrador tendrá que invitarte de nuevo.`}
        confirmLabel="Salir de la clínica"
        pending={leave.isPending}
        onConfirm={() => leave.mutate()}
      />

      <Dialog open={infoOpen} onOpenChange={setInfoOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Información de la cuenta</DialogTitle>
            <DialogDescription>Datos de tu acceso al panel de ClinicAI.</DialogDescription>
          </DialogHeader>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Nombre</dt>
            <dd>{user.name ?? '-'}</dd>
            <dt className="text-muted-foreground">Email</dt>
            <dd>{user.email ?? '-'}</dd>
            <dt className="text-muted-foreground">Clínica</dt>
            <dd>{clinicName}</dd>
            <dt className="text-muted-foreground">Acceso</dt>
            <dd>Email + código de un solo uso (Kinde)</dd>
          </dl>
        </DialogContent>
      </Dialog>
    </>
  );
}
