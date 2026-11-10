import { requirePage } from '@/lib/current-user';
import { canOperateStock } from '@/lib/permissions';
import { PageHeader } from '@/components/shell/AppShell';
import { WarehouseNav } from '@/components/stock/WarehouseNav';
import { CountsClient } from '@/components/stock/CountsClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Тооллого · zahialga•' };

export default async function CountsPage() {
  const { user } = await requirePage('warehouse');
  return (
    <>
      <PageHeader title="Тооллого" subtitle="Агуулах тоолно → зөрүү → Админ батална" />
      <WarehouseNav />
      <CountsClient canOperate={canOperateStock(user.roles)} />
    </>
  );
}
