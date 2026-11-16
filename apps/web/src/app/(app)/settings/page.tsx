import { SettingsView } from '@/components/settings/settings-view';
import { requireAdminSession } from '@/server/session';

export const metadata = { title: 'Ajustes' };

/** Owner and administrators only (F18): professionals are sent back to Inicio. */
export default async function SettingsPage() {
  await requireAdminSession();
  return <SettingsView />;
}
