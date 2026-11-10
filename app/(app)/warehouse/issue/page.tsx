import { redirect } from 'next/navigation';
import { requirePage } from '@/lib/current-user';
import { canOperateStock } from '@/lib/permissions';
import { PageHeader } from '@/components/shell/AppShell';
import { StockDocForm } from '@/components/stock/StockDocForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Зарлага · zahialga•' };

export default async function IssuePage() {
  const { user } = await requirePage('warehouse');
  if (!canOperateStock(user.roles)) redirect('/forbidden');
  return (
    <>
      <PageHeader back={{ href: '/warehouse', label: 'Агуулах руу буцах' }} title="Зарлага" subtitle="Гэмтэл · Дээж, бэлэг, реклам · Нийлүүлэгчид буцаасан" />
      <StockDocForm mode="issue" />
    </>
  );
}
