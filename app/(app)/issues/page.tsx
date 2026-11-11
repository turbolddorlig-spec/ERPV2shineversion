import { requirePage } from '@/lib/current-user';
import { IssuesClient } from '@/components/delivery/IssuesClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Асуудал · zahialga•' };

export default async function IssuesPage() {
  await requirePage('issues');
  return <IssuesClient />;
}
