import { requirePage } from '@/lib/current-user';
import { PageHeader } from '@/components/shell/AppShell';
import { HandoverHistoryClient } from '@/components/delivery/HandoverHistoryClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Падааны түүх · zahialga•' };

export default async function HandoverHistoryPage() {
  await requirePage('handover');
  return (
    <>
      <PageHeader back={{ href: '/handover', label: 'Жолоочид бараа өгөх руу буцах' }} title="Падааны түүх" />
      <HandoverHistoryClient />
    </>
  );
}
