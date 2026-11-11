import { requirePage } from '@/lib/current-user';
import { MyPenaltiesClient } from '@/components/penalties/MyPenaltiesClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Миний торгууль · zahialga•' };

export default async function MyPenaltiesPage() {
  await requirePage('my-penalties');
  return <MyPenaltiesClient />;
}
