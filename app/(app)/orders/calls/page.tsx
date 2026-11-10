import { requirePage } from '@/lib/current-user';
import { OrdersClient } from '@/components/orders/OrdersClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Дуудлагын бүртгэл · zahialga•' };

/** Захиалгын жагсаалт + «Дуудлагын бүртгэл» цонх нээлттэй */
export default async function CallsPage() {
  await requirePage('orders');
  return (
    <>
      <OrdersClient initialModal={{ kind: 'calls' }} />
    </>
  );
}
