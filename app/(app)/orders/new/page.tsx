import { redirect } from 'next/navigation';
import { requirePage } from '@/lib/current-user';
import { OrdersClient } from '@/components/orders/OrdersClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Шинэ захиалга · zahialga•' };

/** Захиалгын жагсаалт + «Шинэ захиалга» цонх нээлттэй (хуучин ERP шиг) */
export default async function NewOrderPage() {
  const { access } = await requirePage('orders');
  if (access !== 'edit') redirect('/forbidden');
  return (
    <>
      <OrdersClient initialModal={{ kind: 'new' }} />
    </>
  );
}
