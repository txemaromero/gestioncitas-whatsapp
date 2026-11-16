import { ActivityView } from '@/components/activity/activity-view';
import { requireAdminSession } from '@/server/session';

export const metadata = { title: 'Registro de actividad' };

/** Owner and administrators only (F24). */
export default async function ActivityPage() {
  await requireAdminSession();
  return <ActivityView />;
}
