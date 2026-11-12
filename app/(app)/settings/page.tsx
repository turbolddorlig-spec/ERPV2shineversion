import { requirePage } from '@/lib/current-user';
import { PageHeader } from '@/components/shell/AppShell';
import { SettingsClient } from '@/components/orders/SettingsClient';
import { GmailSettings } from '@/components/accounting/GmailSettings';
import { OfficeAccess } from '@/components/orders/OfficeAccess';
import { PenaltyAutoSettings } from '@/components/penalties/PenaltyAutoSettings';
import { LegacyImport } from '@/components/orders/LegacyImport';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Тохиргоо · zahialga•' };

export default async function SettingsPage() {
  const { user } = await requirePage('settings');
  return (
    <>
      <PageHeader title="Тохиргоо" subtitle="Хүргэлтийн төлбөр, пэйж, Meta, торгууль, Gmail, ажлын байрнаас нэвтрэх" />
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
      {user.roles.includes('SUPER_ADMIN') ? (
        <section id="legacy-import" className="mt-4 flex min-w-0 flex-col gap-3 rounded-[18px] border border-line bg-surface p-4 shadow-card">
          <h2 className="text-[16px] font-extrabold">Туршилтын оруулалт (хуучин ERP-ээс)</h2>
          <p className="text-[13px] text-subtle">Хуучин ERP-ийн нэг жолоочийн захиалгын жагсаалтыг бүтнээр нь хуулж наагаад «Шалгах» → «Батлах». Бараа (+ «Орлого»), жолооч, захиалга, падаан үүсч, хуучин шигээ Хүргэсэн / Цуцалсан / Маргааш болно. Огноо — өнөөдөр, цалин нягтлангийн «Цалингийн дүрэм»-ийн аргаар (гүйцэтгэлээр / 1 хүргэлт тогтмол). Давтан дарахад давхардахгүй. Зөвхөн Супер админд харагдана.</p>
          <LegacyImport />
        </section>
      ) : null}
      <section id="gmail" className="mt-4 flex flex-col gap-3 rounded-[18px] border border-line bg-surface p-4 shadow-card">
        <h2 className="text-[16px] font-extrabold">Gmail — Хаан банкны мэдэгдэл</h2>
        <p className="text-[13px] text-subtle">Gmail хаяг, 16 оронтой App Password-оо бичээд «Хадгалаад Sync» дарна. Холбогдсоны дараа банкны орлого автоматаар «Банкны импорт»-д орж, утас + дүнгээр захиалга «Мөнгө орсон» болно.</p>
        <GmailSettings />
      </section>
    </>
  );
}
