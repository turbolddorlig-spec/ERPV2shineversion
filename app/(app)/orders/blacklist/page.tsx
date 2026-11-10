import { requirePage } from '@/lib/current-user';
import { PageHeader } from '@/components/shell/AppShell';
import { BlacklistClient } from '@/components/orders/OrderAdminClients';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Хар жагсаалт · zahialga•' };

export default async function Page() {
  await requirePage('orders');
  return (
    <>
      <PageHeader back={{ href: '/orders', label: 'Захиалга руу буцах' }} title="Хар жагсаалт" subtitle="Асуудалтай дугаарууд" />
      <BlacklistClient />
    </>
  );
}
