import { notFound } from 'next/navigation';
import { requirePage } from '@/lib/current-user';
import { PageHeader } from '@/components/shell/AppShell';
import { MovesClient } from '@/components/stock/MovesClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Барааны түүх · zahialga•' };

export default async function ProductStockHistoryPage({ params }: { params: { id: string } }) {
  await requirePage('warehouse');
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  return (
    <>
      <PageHeader back={{ href: '/warehouse', label: 'Агуулах руу буцах' }} title="Барааны түүх" subtitle="Энэ барааны бүх хөдөлгөөн: орлого, шилжүүлэг, зээл, зарлага, тооллого…" />
      <MovesClient productId={id} />
    </>
  );
}
