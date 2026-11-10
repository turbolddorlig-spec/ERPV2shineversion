import { notFound } from 'next/navigation';
import { requirePage } from '@/lib/current-user';
import { canApproveStock, canOperateStock } from '@/lib/permissions';
import { PageHeader } from '@/components/shell/AppShell';
import { CountDetail } from '@/components/stock/CountsClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Тооллого · zahialga•' };

export default async function CountPage({ params }: { params: { id: string } }) {
  const { user } = await requirePage('warehouse');
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  return (
    <>
      <PageHeader back={{ href: '/warehouse/counts', label: 'Тооллого руу буцах' }} title={`Тооллого №${id}`} />
      <CountDetail id={id} canOperate={canOperateStock(user.roles)} canApprove={canApproveStock(user.roles)} />
    </>
  );
}
