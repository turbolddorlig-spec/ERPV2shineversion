import { notFound } from 'next/navigation';
import { requirePage } from '@/lib/current-user';
import { canApproveStock, canOperateStock } from '@/lib/permissions';
import { PageHeader } from '@/components/shell/AppShell';
import { TransferDetail } from '@/components/stock/TransfersClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Шилжүүлэг · zahialga•' };

export default async function TransferPage({ params }: { params: { id: string } }) {
  const { user } = await requirePage('warehouse');
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  return (
    <>
      <PageHeader back={{ href: '/warehouse/transfers', label: 'Шилжүүлэг рүү буцах' }} title={`Шилжүүлэг №${id}`} />
      <TransferDetail id={id} canOperate={canOperateStock(user.roles)} canApprove={canApproveStock(user.roles)} />
    </>
  );
}
