import { requirePage } from '@/lib/current-user';
import { PenaltiesClient } from '@/components/penalties/PenaltiesClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Алдаа удирдлага · zahialga•' };

export default async function PenaltiesPage() {
  await requirePage('penalties');
  return <PenaltiesClient />;
}
