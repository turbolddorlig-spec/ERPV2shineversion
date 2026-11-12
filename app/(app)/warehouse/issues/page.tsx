import { requirePage } from '@/lib/current-user';
import { PageHeader } from '@/components/shell/AppShell';
import { WarehouseNav } from '@/components/stock/WarehouseNav';
import { IssuesReviewClient } from '@/components/stock/IssuesReviewClient';
import { Notice } from '@/components/ui/Notice';
import { canApproveStock } from '@/lib/permissions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Зарлага хянах · zahialga•' };

/** Аудит #143: зарлага шууд гарна — Супер админ, Админ үнийн дүнтэй жагсаалтаар хянаж «Шалгасан» гэж тэмдэглэнэ */
export default async function IssuesReviewPage() {
  const { user } = await requirePage('warehouse');
  return (
    <>
      <PageHeader title="Зарлага хянах" subtitle="Гэмтэл, дээж, бусад зарлага — хэн, хэзээ, юу, хэдэн төгрөгийн. Шалгасныг тэмдэглэнэ." />
      <WarehouseNav />
      {canApproveStock(user.roles) ? <IssuesReviewClient /> : <Notice tone="info">Зарлагыг Супер админ, Админ хянана.</Notice>}
    </>
  );
}
