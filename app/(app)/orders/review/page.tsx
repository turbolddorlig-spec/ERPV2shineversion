import { redirect } from 'next/navigation';
import { requirePage } from '@/lib/current-user';
import { canReviewDiscounts } from '@/lib/permissions';
import { PageHeader } from '@/components/shell/AppShell';
import { DiscountReviewClient } from '@/components/orders/OrderAdminClients';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Хөнгөлөлт шалгах · zahialga•' };

export default async function Page() {
  const { user } = await requirePage('orders');
  if (!canReviewDiscounts(user.roles)) redirect('/forbidden');
  return (
    <>
      <PageHeader back={{ href: '/orders', label: 'Захиалга руу буцах' }} title="Хөнгөлөлт шалгах" subtitle="Операторын үнэ бууруулсан, хүргэлт өөрчилсөн захиалгууд" />
      <DiscountReviewClient />
    </>
  );
}
