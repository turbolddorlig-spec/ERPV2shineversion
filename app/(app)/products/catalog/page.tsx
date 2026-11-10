import { redirect } from 'next/navigation';
import { requirePage } from '@/lib/current-user';
import { canManageCatalogLists } from '@/lib/permissions';
import { PageHeader } from '@/components/shell/AppShell';
import { CatalogClient } from '@/components/products/CatalogClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Ангилал, улирал · zahialga•' };

export default async function CatalogPage() {
  const { user } = await requirePage('products');
  if (!canManageCatalogLists(user.roles)) redirect('/forbidden');
  return (
    <>
      <PageHeader title="Ангилал, улирал" subtitle="Барааг хайх, шүүхэд ашиглана" />
      <div className="grid gap-5 lg:grid-cols-2">
        <CatalogClient kind="categories" title="Ангилал" />
        <CatalogClient kind="seasons" title="Улирал" />
      </div>
    </>
  );
}
