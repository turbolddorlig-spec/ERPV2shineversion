import { requirePage } from '@/lib/current-user';
import { PageHeader } from '@/components/shell/AppShell';
import { OrdersClient } from '@/components/orders/OrdersClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Захиалга · zahialga•' };

export default async function OrdersPage() {
  await requirePage('orders');
  return (
    <>
      <PageHeader title="Захиалга" subtitle="Өнөөдрийн захиалгууд, төлөв бүрээр" />
      <OrdersClient />
    </>
  );
}
