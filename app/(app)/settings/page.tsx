import { requirePage } from '@/lib/current-user';
import { PageHeader } from '@/components/shell/AppShell';
import { SettingsClient } from '@/components/orders/SettingsClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Тохиргоо · zahialga•' };

export default async function SettingsPage() {
  await requirePage('settings');
  return (
    <>
      <PageHeader title="Тохиргоо" subtitle="Хүргэлтийн төлбөр, пэйж, Meta" />
      <SettingsClient />
    </>
  );
}
