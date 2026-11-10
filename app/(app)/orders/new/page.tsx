import { redirect } from 'next/navigation';
import { requirePage } from '@/lib/current-user';
import { PageHeader } from '@/components/shell/AppShell';
import { OrderForm } from '@/components/orders/OrderForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Шинэ захиалга · zahialga•' };

export default async function NewOrderPage() {
  const { access } = await requirePage('orders');
  if (access !== 'edit') redirect('/forbidden');
  return (
    <>
      <PageHeader back={{ href: '/orders', label: 'Захиалга руу буцах' }} title="Шинэ захиалга" />
      <OrderForm />
    </>
  );
}
