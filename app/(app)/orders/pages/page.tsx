import { redirect } from 'next/navigation';
import { requirePage } from '@/lib/current-user';
import { canSuperviseOperators } from '@/lib/permissions';
import { PageHeader } from '@/components/shell/AppShell';
import { PageAssignClient } from '@/components/orders/OrderAdminClients';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Пэйж хуваарилалт · zahialga•' };

export default async function Page() {
  const { user } = await requirePage('orders');
  if (!canSuperviseOperators(user.roles)) redirect('/forbidden');
  return (
    <>
      <PageHeader back={{ href: '/orders', label: 'Захиалга руу буцах' }} title="Пэйж хуваарилалт" subtitle="Оператор бүрийн пэйж" />
      <PageAssignClient />
    </>
  );
}
