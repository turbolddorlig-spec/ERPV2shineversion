import { requirePage } from '@/lib/current-user';
import { PageHeader } from '@/components/shell/AppShell';
import { WarehouseNav } from '@/components/stock/WarehouseNav';
import { MovesClient } from '@/components/stock/MovesClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Хөдөлгөөн · zahialga•' };

export default async function MovesPage() {
  await requirePage('warehouse');
  return (
    <>
      <PageHeader title="Барааны хөдөлгөөн" subtitle="Бүх хөдөлгөөн: хэзээ, хэн, хаанаас → хаашаа. Засах, устгах боломжгүй." />
      <WarehouseNav />
      <MovesClient />
    </>
  );
}
