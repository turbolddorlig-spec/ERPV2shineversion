import { requirePage } from '@/lib/current-user';
import { PageHeader } from '@/components/shell/AppShell';
import { HistoryClient } from '@/components/products/HistoryClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Барааны засвар · zahialga•' };

export default async function ProductHistoryPage() {
  const { user, access } = await requirePage('product-history');
  return (
    <>
      <PageHeader back={{ href: '/products', label: 'Бараа руу буцах' }} title="Барааны засварын түүх" subtitle="Бараанд хийсэн бүх өөрчлөлт: хэн, хэзээ, юу, яагаад. Засах, устгах боломжгүй." />
      <HistoryClient selfId={user.id} canReview={access === 'edit'} superAdmin={user.roles.includes('SUPER_ADMIN')} />
    </>
  );
}
