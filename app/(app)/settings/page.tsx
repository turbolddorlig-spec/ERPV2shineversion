import { requirePage } from '@/lib/current-user';
import { PageHeader } from '@/components/shell/AppShell';
import { SettingsClient } from '@/components/orders/SettingsClient';
import { GmailSettings } from '@/components/accounting/GmailSettings';
import { OfficeAccess } from '@/components/orders/OfficeAccess';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Тохиргоо · zahialga•' };

export default async function SettingsPage() {
  await requirePage('settings');
  return (
    <>
      <PageHeader title="Тохиргоо" subtitle="Хүргэлтийн төлбөр, пэйж, Meta, Gmail, ажлын байрнаас нэвтрэх" />
      <SettingsClient />
      <section id="office" className="mt-4 flex flex-col gap-3 rounded-[18px] border border-line bg-surface p-4 shadow-card">
        <h2 className="text-[16px] font-extrabold">Зөвхөн ажлын байрнаас нэвтрэх</h2>
        <p className="text-[13px] text-subtle">Сонгосон ажилтнууд (жишээ нь оператор, маркетинг) зөвхөн ажлын интернэтээс нэвтэрнэ. Тохируулаагүй бол хаанаас ч нэвтэрнэ.</p>
        <OfficeAccess />
      </section>
      <section id="gmail" className="mt-4 flex flex-col gap-3 rounded-[18px] border border-line bg-surface p-4 shadow-card">
        <h2 className="text-[16px] font-extrabold">Gmail — Хаан банкны мэдэгдэл</h2>
        <p className="text-[13px] text-subtle">Gmail хаяг, 16 оронтой App Password-оо бичээд «Хадгалаад Sync» дарна. Холбогдсоны дараа банкны орлого автоматаар «Банкны импорт»-д орж, утас + дүнгээр захиалга «Мөнгө орсон» болно.</p>
        <GmailSettings />
      </section>
    </>
  );
}
