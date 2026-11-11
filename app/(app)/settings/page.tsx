import { requirePage } from '@/lib/current-user';
import { PageHeader } from '@/components/shell/AppShell';
import { SettingsClient } from '@/components/orders/SettingsClient';
import { GmailSettings } from '@/components/accounting/GmailSettings';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Тохиргоо · zahialga•' };

export default async function SettingsPage() {
  await requirePage('settings');
  return (
    <>
      <PageHeader title="Тохиргоо" subtitle="Хүргэлтийн төлбөр, пэйж, Meta, Gmail (банкны мэдэгдэл)" />
      <SettingsClient />
      <section id="gmail" className="mt-4 flex flex-col gap-3 rounded-[18px] border border-line bg-surface p-4 shadow-card">
        <h2 className="text-[16px] font-extrabold">Gmail — Хаан банкны мэдэгдэл</h2>
        <p className="text-[13px] text-subtle">Gmail хаяг, 16 оронтой App Password-оо бичээд «Хадгалаад Sync» дарна. Холбогдсоны дараа банкны орлого автоматаар «Банкны импорт»-д орж, утас + дүнгээр захиалга «Мөнгө орсон» болно.</p>
        <GmailSettings />
      </section>
    </>
  );
}
