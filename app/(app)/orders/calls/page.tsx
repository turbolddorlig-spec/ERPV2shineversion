import { requirePage } from '@/lib/current-user';
import { PageHeader } from '@/components/shell/AppShell';
import { OrdersClient } from '@/components/orders/OrdersClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Дуудлагын бүртгэл · zahialga•' };

/** Захиалгын жагсаалт + «Дуудлагын бүртгэл» цонх нээлттэй */
export default async function CallsPage() {
  await requirePage('orders');
  return (
    <>
      <PageHeader title="Захиалга" />
      <OrdersClient initialModal={{ kind: 'calls' }} />
    </>
  );
}
