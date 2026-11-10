import { requirePage } from '@/lib/current-user';
import { canApproveStock } from '@/lib/permissions';
import { PageHeader } from '@/components/shell/AppShell';
import { WarehouseNav } from '@/components/stock/WarehouseNav';
import { WarehousesClient } from '@/components/stock/WarehousesClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Агуулахууд · zahialga•' };

export default async function WarehouseSettingsPage() {
  const { user } = await requirePage('warehouse');
  return (
    <>
      <PageHeader title="Агуулахууд" subtitle="Агуулах нэмэх, үндсэнийг сонгох" />
      <WarehouseNav />
      <WarehousesClient canManage={canApproveStock(user.roles)} />
    </>
  );
}
