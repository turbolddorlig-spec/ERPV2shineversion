import { requirePage } from '@/lib/current-user';
import { accessTo, canOperateStock } from '@/lib/permissions';
import { PageHeader } from '@/components/shell/AppShell';
import { WarehouseNav } from '@/components/stock/WarehouseNav';
import { LoansClient } from '@/components/stock/LoansClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Бараа зээл · zahialga•' };

export default async function LoansPage({ searchParams }: { searchParams: { from?: string } }) {
  const { user } = await requirePage('loans');
  // Буцах: захиалгаас орсон бол захиалга руу, агуулахынхан агуулах руу
  const fromOrders = searchParams.from === 'orders' || (!canOperateStock(user.roles) && accessTo(user.roles, 'orders') !== 'none');
  const back = fromOrders ? { href: '/orders', label: 'Захиалга руу буцах' } : canOperateStock(user.roles) ? { href: '/warehouse', label: 'Агуулах руу буцах' } : { href: '/me', label: 'Буцах' };
  return (
    <>
      <PageHeader back={back} title="Бараа зээл" subtitle="Хүсэлт → агуулах олгоно → буцаалт. Буцаагаагүй нь цалингаас (үнэ − хямдрал)." />
      {canOperateStock(user.roles) ? <WarehouseNav /> : null}
      <LoansClient selfId={user.id} />
    </>
  );
}
