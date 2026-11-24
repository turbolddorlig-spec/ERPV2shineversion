import { requirePage } from '@/lib/current-user';
import { PageHeader } from '@/components/shell/AppShell';
import { SettingsClient } from '@/components/orders/SettingsClient';
import { GmailSettings } from '@/components/accounting/GmailSettings';
import { BankSmsSettings } from '@/components/accounting/BankSmsSettings';
import { OfficeAccess } from '@/components/orders/OfficeAccess';
import { PenaltyAutoSettings } from '@/components/penalties/PenaltyAutoSettings';
import { DriveSettings } from '@/components/orders/DriveSettings';
import { BrandSettings } from '@/components/orders/BrandSettings';
import { BorderSettings } from '@/components/settings/BorderSettings';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Тохиргоо' };

export default async function SettingsPage() {
  const { user } = await requirePage('settings');
  return (
    <>
      <PageHeader title="Тохиргоо" subtitle="Хүргэлтийн төлбөр, пэйж, Meta, SMS, торгууль, Gmail, нөөц хуулбар, ажлын байрнаас нэвтрэх" />
      <SettingsClient />
      <section id="penalty" className="mt-4 flex flex-col gap-3 rounded-[18px] border border-line bg-surface p-4 shadow-card">
        <h2 className="text-[16px] font-extrabold">Торгуулийн дүн (автомат)</h2>
        <p className="text-[13px] text-subtle">«Опп-руу явуулах» асуудлыг цуцлахад хэний алдаа гэснээр хариуцагчид автоматаар тавигдах торгууль. Жолоочийн алдаа — торгуульгүй. Алдааны нэрс «Алдаа удирдлага» хуудсанд.</p>
        <PenaltyAutoSettings />
      </section>
      <section id="office" className="mt-4 flex flex-col gap-3 rounded-[18px] border border-line bg-surface p-4 shadow-card">
        <h2 className="text-[16px] font-extrabold">Зөвхөн ажлын байрнаас нэвтрэх</h2>
        <p className="text-[13px] text-subtle">Сонгосон ажилтнууд (жишээ нь оператор, маркетинг) зөвхөн ажлын интернэтээс нэвтэрнэ. Тохируулаагүй бол хаанаас ч нэвтэрнэ.</p>
        <OfficeAccess />
      </section>
      <section id="gmail" className="mt-4 flex flex-col gap-3 rounded-[18px] border border-line bg-surface p-4 shadow-card">
        <h2 className="text-[16px] font-extrabold">Банкны орлого — Gmail ба утас (Хаан банк)</h2>
        <p className="text-[13px] text-subtle">Gmail хаяг, 16 оронтой App Password-оо бичээд «Хадгалаад Sync» дарна. Холбогдсоны дараа банкны орлого автоматаар «Банкны импорт»-д орж, утас + дүнгээр захиалга «Мөнгө орсон» болно.</p>
        <GmailSettings />
        {user.roles.includes('SUPER_ADMIN') ? <BankSmsSettings /> : null}
      </section>
      {user.roles.includes('SUPER_ADMIN') ? <BorderSettings /> : null}
      {user.roles.includes('SUPER_ADMIN') ? <><BrandSettings /><DriveSettings /></> : null}
    </>
  );
}
