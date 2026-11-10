import { requirePage } from '@/lib/current-user';
import { canOperateStock } from '@/lib/permissions';
import { PageHeader } from '@/components/shell/AppShell';
import { WarehouseNav } from '@/components/stock/WarehouseNav';
import { TransfersClient } from '@/components/stock/TransfersClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Шилжүүлэг · zahialga•' };

export default async function TransfersPage() {
  const { user } = await requirePage('warehouse');
  return (
    <>
      <PageHeader title="Шилжүүлэг" subtitle="Илгээсэн → замдаа → хүлээн авах агуулах тоолж батална" />
      <WarehouseNav />
      <TransfersClient canOperate={canOperateStock(user.roles)} />
    </>
  );
}
