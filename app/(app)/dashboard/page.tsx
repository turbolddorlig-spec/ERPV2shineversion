import { requirePage } from '@/lib/current-user';
import { DashboardClient } from '@/components/dashboard/DashboardClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Хянах самбар · zahialga•' };

export default async function DashboardPage() {
  await requirePage('dashboard');
  return <DashboardClient />;
}
