import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Logo } from '@/components/layout/logo';
import { OnboardingForm } from '@/components/settings/onboarding-form';
import { verifiedEmail } from '@/server/identity';
import { isPlatformAdmin } from '@/server/platform';
import { getSession } from '@/server/session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Crea tu clínica' };

export default async function OnboardingPage() {
  const { user, member } = await getSession();
  if (!user) redirect('/');
  if (member) redirect('/dashboard');
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-8 bg-muted/40 px-4">
      <Logo />
      <div className="w-full max-w-md rounded-xl border bg-background p-6 shadow-xs">
        <h1 className="text-xl font-bold">Crea tu clínica</h1>
        <p className="mt-1 mb-6 text-sm text-muted-foreground">
          Es el primer paso: después podrás dar de alta a tus profesionales y conectar WhatsApp.
        </p>
        <OnboardingForm />
      </div>
      {isPlatformAdmin(verifiedEmail(user)) ? (
        <Link href="/plataforma" className="text-sm font-medium text-primary underline-offset-4 hover:underline">
          Ir a la consola de la plataforma
        </Link>
      ) : null}
    </div>
  );
}
