import { requirePage } from '@/lib/current-user';
import { canOperateStock } from '@/lib/permissions';
import { PageHeader } from '@/components/shell/AppShell';
import { WarehouseNav } from '@/components/stock/WarehouseNav';
import { LoansClient } from '@/components/stock/LoansClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Бараа зээл · zahialga•' };

export default async function LoansPage() {
  const { user } = await requirePage('loans');
  return (
    <>
      <PageHeader title="Бараа зээл" subtitle="Хүсэлт → агуулах олгоно → буцаалт. Буцаагаагүй нь цалингаас (үнэ − хямдрал)." />
      {canOperateStock(user.roles) ? <WarehouseNav /> : null}
      <LoansClient selfId={user.id} />
    </>
  );
}
