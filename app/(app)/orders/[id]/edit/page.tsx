import { notFound, redirect } from 'next/navigation';
import { requirePage } from '@/lib/current-user';
import { OrdersClient } from '@/components/orders/OrdersClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Захиалга засах · zahialga•' };

/** Захиалгын жагсаалт + засах цонх нээлттэй */
export default async function EditOrderPage({ params }: { params: { id: string } }) {
  const { access } = await requirePage('orders');
  if (access !== 'edit') redirect('/forbidden');
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  return (
    <>
      <OrdersClient initialModal={{ kind: 'edit', id }} />
    </>
  );
}
