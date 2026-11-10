import { requirePage } from '@/lib/current-user';
import { PageHeader } from '@/components/shell/AppShell';
import { CallsClient } from '@/components/orders/CallsClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Дуудлагын бүртгэл · zahialga•' };

export default async function CallsPage() {
  await requirePage('orders');
  return (
    <>
      <PageHeader back={{ href: '/orders', label: 'Захиалга руу буцах' }} title="Дуудлагын бүртгэл" subtitle="Залгах дугаарууд — 5 оролдлого, хооронд 30 минут" />
      <CallsClient />
    </>
  );
}
