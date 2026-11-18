import { requirePage } from '@/lib/current-user';
import { ReorderClient } from '@/components/outflow/ReorderClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Бараа татах · zahialga•' };

export default async function ReorderPage() {
  await requirePage('reorder');
  return <ReorderClient />;
}
