import { redirect } from 'next/navigation';
import { requirePage } from '@/lib/current-user';
import { canOperateStock } from '@/lib/permissions';
import { PageHeader } from '@/components/shell/AppShell';
import { StockDocForm } from '@/components/stock/StockDocForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Орлого · zahialga•' };

export default async function ReceiptPage() {
  const { user } = await requirePage('warehouse');
  if (!canOperateStock(user.roles)) redirect('/forbidden');
  return (
    <>
      <PageHeader back={{ href: '/warehouse', label: 'Агуулах руу буцах' }} title="Орлого" subtitle="Ирсэн барааг агуулахад бүртгэнэ" />
      <StockDocForm mode="receipt" />
    </>
  );
}
