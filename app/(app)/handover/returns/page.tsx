import { requirePage } from '@/lib/current-user';
import { ReturnsClient } from '@/components/delivery/ReturnsClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Буцаалт хүлээн авах · zahialga•' };

export default async function ReturnsPage() {
  await requirePage('handover');
  return <ReturnsClient />;
}
