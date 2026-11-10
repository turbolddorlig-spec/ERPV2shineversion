import { requirePage } from '@/lib/current-user';
import { HandoverClient } from '@/components/delivery/HandoverClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Жолоочид бараа өгөх · zahialga•' };

export default async function HandoverPage() {
  await requirePage('handover');
  return <HandoverClient />;
}
