import { requirePage } from '@/lib/current-user';
import { OutflowClient } from '@/components/outflow/OutflowClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Барааны гарц · zahialga•' };

export default async function GoodsOutflowPage() {
  await requirePage('goods-outflow');
  return <OutflowClient />;
}
