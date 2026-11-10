import { requirePage } from '@/lib/current-user';
import { PageHeader } from '@/components/shell/AppShell';
import { ReportsClient } from '@/components/orders/ReportsClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Тайлан · zahialga•' };

export default async function ReportsPage() {
  await requirePage('reports');
  return (
    <>
      <PageHeader title="Тайлан" subtitle="Пэйж, дуудлагын тайлан (зөвхөн тоо)" />
      <ReportsClient />
    </>
  );
}
