import { requirePage } from '@/lib/current-user';
import { canApproveStock, canOperateStock } from '@/lib/permissions';
import { PageHeader } from '@/components/shell/AppShell';
import { WarehouseNav } from '@/components/stock/WarehouseNav';
import { WarehouseClient } from '@/components/stock/WarehouseClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Агуулах · zahialga•' };

export default async function WarehousePage() {
  const { user } = await requirePage('warehouse');
  return (
    <>
      <PageHeader title="Агуулах" subtitle="Агуулах тус бүрийн үлдэгдэл, өнөөдрийн ажил" />
      <WarehouseNav />
      <WarehouseClient canOperate={canOperateStock(user.roles)} canApprove={canApproveStock(user.roles)} />
    </>
  );
}
