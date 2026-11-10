import { redirect } from 'next/navigation';
import { requirePage } from '@/lib/current-user';
import { canOperateStock } from '@/lib/permissions';
import { PageHeader } from '@/components/shell/AppShell';
import { StockDocForm } from '@/components/stock/StockDocForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Шилжүүлэг · zahialga•' };

export default async function NewTransferPage() {
  const { user } = await requirePage('warehouse');
  if (!canOperateStock(user.roles)) redirect('/forbidden');
  return (
    <>
      <PageHeader back={{ href: '/warehouse/transfers', label: 'Шилжүүлэг рүү буцах' }} title="Шилжүүлэг илгээх" subtitle="Илгээсэн бараа «замдаа» болж, хүлээн авах агуулах тоолж баталсны дараа нэмэгдэнэ" />
      <StockDocForm mode="transfer" />
    </>
  );
}
