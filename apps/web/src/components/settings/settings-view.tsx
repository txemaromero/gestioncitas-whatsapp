'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLinkIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { MIN_NOTICE_HOUR_OPTIONS, RETENTION_MONTH_OPTIONS, SECOND_REMINDER_HOUR_OPTIONS } from '@clinicai/shared';
import { Button } from '@/components/ui/button';
import { Field, Input, NativeSelect } from '@/components/ui/form-controls';
import { TimeOffPanel } from '@/components/time-off/time-off-panel';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader, Skeleton } from '@/components/ui/misc';
import { errorMessage } from '@/lib/utils';
import type { TenantView } from '@/server/routers/tenant';
import { useTRPC } from '@/trpc/react';
import { BookingPageCard } from './booking-page-card';
import { AssistantInfoCard } from './assistant-info-card';
import { ServicesCard } from './services-card';
import { TeamCard } from './team-card';

const SLOT_OPTIONS = [15, 20, 30, 45, 60, 90, 120];

export function SettingsView() {
  const trpc = useTRPC();
  const tenant = useQuery(trpc.tenant.get.queryOptions());
  if (!tenant.data) return <Skeleton className="h-96" />;
  // Forms are initialized from the loaded tenant (no syncing effects).
  return <SettingsForms key={tenant.data.id} tenant={tenant.data} />;
}

function SettingsForms({ tenant: initial }: { tenant: TenantView }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const router = useRouter();
  const tenant = useQuery({ ...trpc.tenant.get.queryOptions(), initialData: initial });

  const [business, setBusiness] = useState({
    clinicName: initial.clinicName,
    contactPhone: initial.contactPhone,
    slotMinutes: initial.slotMinutes,
    reminderHour: initial.reminderHour,
    reminderDaysBefore: initial.reminderDaysBefore,
    secondReminderHours: initial.secondReminderHours,
    minNoticeHours: initial.minNoticeHours,
    waitlistEnabled: initial.waitlistEnabled,
    packNoShowSpends: initial.packNoShowSpends,
  });
  const [wa, setWa] = useState({
    waPhoneNumberId: initial.waPhoneNumberId ?? '',
    phoneNormalized: initial.phoneNormalized ?? '',
    token: '',
  });
  const [privacy, setPrivacy] = useState({
    privacyPolicyUrl: initial.privacyPolicyUrl ?? '',
    retentionMonths: initial.retentionMonths,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.tenant.pathKey() });
    router.refresh();
  };
  const update = useMutation(
    trpc.tenant.update.mutationOptions({
      onSuccess: () => {
        toast.success('Ajustes guardados');
        refresh();
      },
      onError: (e) => toast.error(errorMessage(e)),
    }),
  );
  const updateWa = useMutation(
    trpc.tenant.updateWhatsApp.mutationOptions({
      onSuccess: () => {
        toast.success('Configuración de WhatsApp guardada');
        setWa((w) => ({ ...w, token: '' }));
        refresh();
      },
      onError: (e) => toast.error(errorMessage(e)),
    }),
  );
  const updatePrivacy = useMutation(
    trpc.tenant.updatePrivacy.mutationOptions({
      onSuccess: () => {
        toast.success('Ajustes de protección de datos guardados');
        refresh();
      },
      onError: (e) => toast.error(errorMessage(e)),
    }),
  );


  return (
    <>
      <PageHeader title="Ajustes" description="Personaliza tu clínica y el comportamiento del asistente de WhatsApp." />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Negocio</CardTitle>
            <CardDescription>El nombre aparece en todos los mensajes del bot.</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                update.mutate(business);
              }}
            >
              <Field label="Nombre del negocio" htmlFor="clinicName" required>
                <Input
                  id="clinicName"
                  value={business.clinicName}
                  onChange={(e) => setBusiness({ ...business, clinicName: e.target.value })}
                />
              </Field>
              <Field label="Teléfono de contacto" htmlFor="contactPhone" hint="Se sugiere al paciente tras 3 fallos de comprensión.">
                <Input
                  id="contactPhone"
                  inputMode="tel"
                  value={business.contactPhone}
                  onChange={(e) => setBusiness({ ...business, contactPhone: e.target.value })}
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Duración de la cita" htmlFor="slotMinutes">
                  <NativeSelect
                    id="slotMinutes"
                    value={business.slotMinutes}
                    onChange={(e) => setBusiness({ ...business, slotMinutes: Number(e.target.value) })}
                  >
                    {SLOT_OPTIONS.map((m) => (
                      <option key={m} value={m}>
                        {m} minutos
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <Field label="Hora de los recordatorios" htmlFor="reminderHour">
                  <Input
                    id="reminderHour"
                    type="time"
                    value={business.reminderHour}
                    onChange={(e) => setBusiness({ ...business, reminderHour: e.target.value })}
                  />
                </Field>
              </div>
              {/* F30: when the reminders go out. */}
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Primer recordatorio" htmlFor="reminderDaysBefore" hint="A la hora de los recordatorios. Pide confirmar la cita.">
                  <NativeSelect
                    id="reminderDaysBefore"
                    value={business.reminderDaysBefore}
                    onChange={(e) => setBusiness({ ...business, reminderDaysBefore: Number(e.target.value) })}
                  >
                    <option value={1}>1 día antes</option>
                    <option value={2}>2 días antes</option>
                  </NativeSelect>
                </Field>
                <Field label="Segundo aviso (el mismo día)" htmlFor="secondReminderHours" hint="Nunca antes de las 8:00 ni después de las 21:00.">
                  <NativeSelect
                    id="secondReminderHours"
                    value={business.secondReminderHours ?? ''}
                    onChange={(e) => setBusiness({ ...business, secondReminderHours: e.target.value ? Number(e.target.value) : null })}
                  >
                    <option value="">No enviar</option>
                    {SECOND_REMINDER_HOUR_OPTIONS.map((h) => (
                      <option key={h} value={h}>
                        {h} horas antes
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              </div>
              <Field
                label="Antelación para cancelar o cambiar por WhatsApp"
                htmlFor="minNoticeHours"
                hint="Con menos antelación, el bot no cancela ni cambia la cita y da el teléfono de contacto."
              >
                <NativeSelect
                  id="minNoticeHours"
                  value={business.minNoticeHours}
                  onChange={(e) => setBusiness({ ...business, minNoticeHours: Number(e.target.value) })}
                >
                  {MIN_NOTICE_HOUR_OPTIONS.map((h) => (
                    <option key={h} value={h}>
                      {h === 0 ? 'Sin límite (hasta la hora de la cita)' : `${h} horas antes`}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <div className="grid gap-1.5">
                <label htmlFor="waitlistEnabled" className="flex items-start gap-2 text-sm font-medium">
                  <input
                    id="waitlistEnabled"
                    type="checkbox"
                    className="mt-0.5 size-4 accent-primary"
                    checked={business.waitlistEnabled}
                    onChange={(e) => setBusiness({ ...business, waitlistEnabled: e.target.checked })}
                  />
                  Lista de espera
                </label>
                <p className="text-xs text-muted-foreground">
                  Si no hay hueco, el bot ofrece apuntarse; cuando alguien cancela, avisa al primero de la lista para que lo reserve.
                  Antes de activarla, la plantilla de aviso de hueco libre tiene que estar aprobada en Meta.
                </p>
              </div>
              <div className="grid gap-1.5">
                <label htmlFor="packNoShowSpends" className="flex items-start gap-2 text-sm font-medium">
                  <input
                    id="packNoShowSpends"
                    type="checkbox"
                    className="mt-0.5 size-4 accent-primary"
                    checked={business.packNoShowSpends}
                    onChange={(e) => setBusiness({ ...business, packNoShowSpends: e.target.checked })}
                  />
                  Las ausencias sin avisar descuentan una sesión del bono
                </label>
                <p className="text-xs text-muted-foreground">
                  Al marcar «No vino» en una cita, se gasta una sesión del bono del cliente, igual que si hubiera venido. Si no se marca,
                  solo descuentan las citas a las que asistió.
                </p>
              </div>
              <Button type="submit" className="w-fit" disabled={update.isPending}>
                {update.isPending ? 'Guardando…' : 'Guardar Cambios'}
              </Button>
            </form>
          </CardContent>
        </Card>

        <AssistantInfoCard />

        <Card>
          <CardHeader>
            <CardTitle>WhatsApp</CardTitle>
            <CardDescription>Datos de tu número en WhatsApp Cloud API (Meta for Developers).</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                updateWa.mutate({
                  waPhoneNumberId: wa.waPhoneNumberId.trim() || null,
                  phoneNormalized: wa.phoneNormalized.trim() || null,
                  ...(wa.token.trim() ? { waAccessToken: wa.token.trim() } : {}),
                });
              }}
            >
              <Field label="Phone number ID" htmlFor="waPhoneNumberId" hint="Identificador del número (no es el teléfono).">
                <Input id="waPhoneNumberId" value={wa.waPhoneNumberId} onChange={(e) => setWa({ ...wa, waPhoneNumberId: e.target.value })} />
              </Field>
              <Field label="Número de WhatsApp del negocio" htmlFor="phoneNormalized">
                <Input
                  id="phoneNormalized"
                  inputMode="tel"
                  placeholder="+34 965 000 000"
                  value={wa.phoneNormalized}
                  onChange={(e) => setWa({ ...wa, phoneNormalized: e.target.value })}
                />
              </Field>
              <Field
                label="Token de acceso"
                htmlFor="waToken"
                hint={
                  tenant.data?.waTokenMasked
                    ? `Guardado y cifrado: ${tenant.data.waTokenMasked}. Déjalo vacío para conservarlo.`
                    : 'Sin token propio: se usa el token global del servidor.'
                }
              >
                <Input
                  id="waToken"
                  type="password"
                  autoComplete="off"
                  value={wa.token}
                  onChange={(e) => setWa({ ...wa, token: e.target.value })}
                />
              </Field>
              <Button type="submit" className="w-fit" disabled={updateWa.isPending}>
                {updateWa.isPending ? 'Guardando…' : 'Guardar WhatsApp'}
              </Button>
            </form>
          </CardContent>
        </Card>

        <BookingPageCard tenant={tenant.data} />

        <TeamCard />

        <ServicesCard />

        <Card>
          <CardHeader>
            <CardTitle>Festivos y cierres</CardTitle>
            <CardDescription>
              Días u horas en que la clínica no abre. Ni el bot ni el calendario permiten reservar en ellos. Las ausencias de
              cada profesional se gestionan en Empleados.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TimeOffPanel employeeId={null} reasonPlaceholder="Festivo local, inventario…" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Protección de datos</CardTitle>
            <CardDescription>
              Antes de registrar a alguien, el bot muestra un aviso de privacidad y pide que lo acepte. Desde la ficha
              de cada cliente puedes exportar o borrar todos sus datos.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                updatePrivacy.mutate({ privacyPolicyUrl: privacy.privacyPolicyUrl.trim(), retentionMonths: privacy.retentionMonths });
              }}
            >
              <Field
                label="Política de privacidad (URL)"
                htmlFor="privacyPolicyUrl"
                hint="El aviso del bot enlaza a esta página. Debe empezar por https://."
              >
                <Input
                  id="privacyPolicyUrl"
                  type="url"
                  inputMode="url"
                  placeholder="https://tuclinica.es/privacidad"
                  value={privacy.privacyPolicyUrl}
                  onChange={(e) => setPrivacy({ ...privacy, privacyPolicyUrl: e.target.value })}
                />
              </Field>
              <Field
                label="Conservación de datos"
                htmlFor="retentionMonths"
                hint="Anonimiza automáticamente a los clientes sin citas durante ese tiempo (se conservan las citas, sin nombre ni notas)."
              >
                <NativeSelect
                  id="retentionMonths"
                  value={privacy.retentionMonths ?? ''}
                  onChange={(e) => setPrivacy({ ...privacy, retentionMonths: e.target.value ? Number(e.target.value) : null })}
                >
                  <option value="">Desactivado (no se anonimiza a nadie)</option>
                  {RETENTION_MONTH_OPTIONS.map((m) => (
                    <option key={m} value={m}>
                      {m / 12 === 1 ? '1 año' : `${m / 12} años`} sin citas
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Button type="submit" className="w-fit" disabled={updatePrivacy.isPending}>
                {updatePrivacy.isPending ? 'Guardando…' : 'Guardar Protección de Datos'}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Atención humana (Chatwoot)</CardTitle>
            <CardDescription>
              Conversaciones completas de WhatsApp y respuesta manual. En una conversación, escribe la nota privada
              <code className="mx-1 rounded bg-muted px-1">/bot off</code> para pausar el bot y
              <code className="mx-1 rounded bg-muted px-1">/bot on</code> para reactivarlo.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {tenant.data?.chatwootUrl ? (
              <a href={tenant.data.chatwootUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline">
                Abrir Chatwoot <ExternalLinkIcon className="size-4" />
              </a>
            ) : (
              <p className="text-sm text-muted-foreground">Chatwoot no está configurado para esta instalación.</p>
            )}
          </CardContent>
        </Card>
      </div>

    </>
  );
}
