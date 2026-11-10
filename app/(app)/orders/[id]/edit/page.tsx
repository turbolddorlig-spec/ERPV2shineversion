import { notFound, redirect } from 'next/navigation';
import { requirePage } from '@/lib/current-user';
import { getOrder } from '@/lib/services/orders/queries';
import { PageHeader } from '@/components/shell/AppShell';
import { OrderForm } from '@/components/orders/OrderForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Захиалга засах · zahialga•' };

export default async function EditOrderPage({ params }: { params: { id: string } }) {
  const { user, access } = await requirePage('orders');
  if (access !== 'edit') redirect('/forbidden');
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const o = await getOrder({ id: user.id, name: user.name, roles: user.roles }, id).catch(() => null);
  if (!o) notFound();
  if (!['PENDING_PAYMENT', 'NEW', 'ASSIGNED'].includes(o.status)) redirect(`/orders/${id}`);
  return (
    <>
      <PageHeader back={{ href: `/orders/${id}`, label: 'Захиалга руу буцах' }} title={`№${o.number} засах`} subtitle={o.inHandover ? 'Падаанд орсон — барааг засахгүй' : undefined} />
      <OrderForm edit={JSON.parse(JSON.stringify(o))} />
    </>
  );
}
