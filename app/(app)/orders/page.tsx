import { requirePage } from '@/lib/current-user';
import { OrdersClient } from '@/components/orders/OrdersClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Захиалга · zahialga•' };

export default async function OrdersPage() {
  await requirePage('orders');
  return (
    <>
      <OrdersClient />
    </>
  );
}
