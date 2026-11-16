import { notFound } from 'next/navigation';
import { PlatformConsoleView } from '@/components/platform/platform-console';
import { loadPlatformConsole } from '@/server/platform';
import { getPlatformAdmin } from '@/server/session';

export const metadata = { title: 'Consola de la plataforma' };

/**
 * F31: figures of every clinic for the platform administrators (PLATFORM_ADMIN_EMAILS). Anyone else
 * gets a 404, as if the page did not exist. Works without belonging to a clinic.
 */
export default async function PlatformPage({ searchParams }: { searchParams: Promise<{ mes?: string | string[] }> }) {
  if (!(await getPlatformAdmin())) notFound();
  const { mes } = await searchParams;
  const data = await loadPlatformConsole(typeof mes === 'string' ? mes : undefined);
  return <PlatformConsoleView data={data} />;
}
