import { requirePage } from '@/lib/current-user';
import { canManageCatalogLists, canSeeCost, canView } from '@/lib/permissions';
import { PageHeader } from '@/components/shell/AppShell';
import { ProductsClient } from '@/components/products/ProductsClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Бараа · zahialga•' };

export default async function ProductsPage() {
  const { user, access } = await requirePage('products');
  return (
    <>
      <PageHeader title="Бараа" subtitle={access === 'view' ? 'Танд зөвхөн харах эрх бий' : 'Барааны бүртгэл, хувилбар, зураг'} />
      <ProductsClient
        canEdit={access === 'edit'}
        showCost={canSeeCost(user.roles)}
        canManageLists={canManageCatalogLists(user.roles)}
        canSeeHistory={canView(user.roles, 'product-history')}
      />
    </>
  );
}
