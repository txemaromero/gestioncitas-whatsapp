import { LoginLink } from '@kinde-oss/kinde-auth-nextjs/components';
import { BotIcon, CalendarDaysIcon, MessageCircleIcon, ShieldCheckIcon } from 'lucide-react';
import Link from 'next/link';
import { Logo } from '@/components/layout/logo';
import { buttonVariants } from '@/components/ui/button';
import { getSession } from '@/server/session';

export const dynamic = 'force-dynamic';

const FEATURES = [
  {
    icon: MessageCircleIcon,
    title: 'Citas por WhatsApp, 24/7',
    text: 'Tus pacientes reservan desde el chat que ya usan, a cualquier hora y sin instalar nada.',
  },
  {
    icon: BotIcon,
    title: 'Asistente con IA',
    text: 'Entiende fechas en lenguaje natural y responde las dudas frecuentes de tu clínica.',
  },
  {
    icon: CalendarDaysIcon,
    title: 'Calendario centralizado',
    text: 'Todas las citas, profesionales y clientes en un panel claro, sincronizado en tiempo real.',
  },
  {
    icon: ShieldCheckIcon,
    title: 'Recordatorios automáticos',
    text: 'Aviso 24 h antes con confirmación o cancelación en un toque: menos ausencias.',
  },
];

async function currentUser() {
  try {
    return (await getSession()).user;
  } catch {
    // The landing must render even if the database is unreachable.
    return null;
  }
}

export default async function LandingPage() {
  const user = await currentUser();
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
        <Logo />
        {user ? (
          <Link href="/dashboard" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Ir al panel
          </Link>
        ) : (
          <LoginLink postLoginRedirectURL="/dashboard" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Iniciar sesión
          </LoginLink>
        )}
      </header>

      <main className="flex-1">
        <section className="mx-auto max-w-6xl px-4 pt-16 pb-20 text-center sm:px-6 sm:pt-24">
          <p className="mb-4 inline-flex rounded-full border bg-accent px-3 py-1 text-xs font-medium text-accent-foreground">
            Gestión de citas con inteligencia artificial
          </p>
          <h1 className="mx-auto max-w-3xl text-4xl font-bold tracking-tight text-balance sm:text-6xl">
            Simplifica la gestión de tu clínica de fisioterapia
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground text-pretty">
            Tus pacientes piden cita por WhatsApp a cualquier hora y un asistente con IA las registra automáticamente en tu
            calendario. Tú solo te ocupas de atenderles.
          </p>
          <div className="mt-10 flex justify-center gap-3">
            {user ? (
              <Link href="/dashboard" className={buttonVariants({ size: 'lg' })}>
                Empezar
              </Link>
            ) : (
              <LoginLink postLoginRedirectURL="/dashboard" className={buttonVariants({ size: 'lg' })}>
                Empezar
              </LoginLink>
            )}
          </div>
        </section>

        <section className="border-t bg-muted/40">
          <div className="mx-auto grid max-w-6xl gap-6 px-4 py-16 sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
            {FEATURES.map(({ icon: Icon, title, text }) => (
              <div key={title} className="rounded-xl border bg-background p-5">
                <Icon className="size-6 text-primary" />
                <h2 className="mt-4 font-semibold">{title}</h2>
                <p className="mt-2 text-sm text-muted-foreground">{text}</p>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t py-6 text-center text-xs text-muted-foreground">
        © {new Date().getFullYear()} ClinicAI · Asistente virtual: los pacientes saben siempre que hablan con una IA.
      </footer>
    </div>
  );
}
