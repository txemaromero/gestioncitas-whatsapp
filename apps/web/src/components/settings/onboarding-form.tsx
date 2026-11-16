'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form-controls';
import { errorMessage } from '@/lib/utils';
import { useTRPC } from '@/trpc/react';

const schema = z.object({
  clinicName: z.string().trim().min(2, 'Mínimo 2 caracteres').max(80),
  contactPhone: z.string().trim().min(6, 'Indica un teléfono de contacto').max(30),
});
type Values = z.infer<typeof schema>;

export function OnboardingForm() {
  const trpc = useTRPC();
  const router = useRouter();
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { clinicName: '', contactPhone: '' } });
  const onboarding = useMutation(
    trpc.tenant.onboarding.mutationOptions({
      onSuccess: () => {
        toast.success('¡Clínica creada!');
        router.replace('/dashboard');
        router.refresh();
      },
      onError: (error) => toast.error(errorMessage(error)),
    }),
  );
  const { errors } = form.formState;
  return (
    <form className="grid gap-4" onSubmit={form.handleSubmit((values) => onboarding.mutate(values))} noValidate>
      <Field label="Nombre de la clínica" htmlFor="clinicName" required error={errors.clinicName?.message}>
        <Input id="clinicName" placeholder="Ej.: Fisioterapia Alicante" aria-invalid={!!errors.clinicName} {...form.register('clinicName')} />
      </Field>
      <Field
        label="Teléfono de contacto"
        htmlFor="contactPhone"
        required
        hint="El bot lo sugerirá a los pacientes cuando no pueda ayudarles."
        error={errors.contactPhone?.message}
      >
        <Input id="contactPhone" inputMode="tel" placeholder="965 000 000" aria-invalid={!!errors.contactPhone} {...form.register('contactPhone')} />
      </Field>
      <Button type="submit" disabled={onboarding.isPending}>
        {onboarding.isPending ? 'Creando…' : 'Crear clínica'}
      </Button>
    </form>
  );
}
