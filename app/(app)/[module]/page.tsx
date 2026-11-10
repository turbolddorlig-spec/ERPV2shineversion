import { notFound } from 'next/navigation';
import { requirePage } from '@/lib/current-user';
import { PAGES, type PageKey } from '@/lib/permissions';
import { PageHeader } from '@/components/shell/AppShell';
import { Badge } from '@/components/ui/Badge';

export const dynamic = 'force-dynamic';

/** Дараагийн модулиудад бүтээгдэх хуудсуудын түр орлогч. Эрхийн шалгалт аль хэдийн ажиллана. */
export default async function ModulePlaceholder({ params }: { params: { module: string } }) {
  const page = PAGES.find((p) => p.href === `/${params.module}`);
  if (!page || page.module === 0) notFound();
  const { access } = await requirePage(page.key as PageKey);
  return (
    <>
      <PageHeader title={page.label} subtitle={access === 'view' ? 'Танд зөвхөн харах эрх бий' : undefined} />
      <div className="rounded-[18px] border border-dashed border-line bg-surface p-8 text-center">
        <Badge tone="accent">Модуль {page.module}</Badge>
        <p className="mt-3 text-[16px] font-bold">Энэ хуудас Модуль {page.module}-д бүтээгдэнэ</p>
        <p className="mt-1 text-[14px] text-muted">Таны эрх энэ хуудсанд аль хэдийн тохируулагдсан байна.</p>
      </div>
    </>
  );
}
