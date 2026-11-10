import { requirePage } from '@/lib/current-user';
import { canOperateStock } from '@/lib/permissions';
import { PageHeader } from '@/components/shell/AppShell';
import { WarehouseNav } from '@/components/stock/WarehouseNav';
import { RefillClient } from '@/components/stock/RefillClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Дүүргэлт · zahialga•' };

export default async function RefillPage() {
  const { user } = await requirePage('warehouse');
  return (
    <>
      <PageHeader title="Үндсэн агуулахын дүүргэлт" subtitle="Хүргэлтэд гарах захиалгын бараа тавиурт хүрэлцэх эсэх" />
      <WarehouseNav />
      <RefillClient canOperate={canOperateStock(user.roles)} />
    </>
  );
}
