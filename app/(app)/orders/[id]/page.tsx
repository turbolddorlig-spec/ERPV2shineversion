import { notFound } from 'next/navigation';
import { requirePage } from '@/lib/current-user';
import { db } from '@/lib/db';
import { PageHeader } from '@/components/shell/AppShell';
import { OrderDetail } from '@/components/orders/OrderDetail';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Захиалга · zahialga•' };

export default async function OrderPage({ params }: { params: { id: string } }) {
  await requirePage('orders');
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const o = await db.order.findUnique({ where: { id }, select: { number: true } });
  if (!o) notFound();
  return (
    <>
      <PageHeader back={{ href: '/orders', label: 'Захиалга руу буцах' }} title={`Захиалга №${o.number}`} />
      <OrderDetail id={id} />
    </>
  );
}
