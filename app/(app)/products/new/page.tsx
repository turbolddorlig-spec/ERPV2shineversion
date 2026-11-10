import { redirect } from 'next/navigation';
import { requirePage } from '@/lib/current-user';
import { canChangeProductCode, canChangeProductStatus, canSeeCost } from '@/lib/permissions';
import { PageHeader } from '@/components/shell/AppShell';
import { ProductEditor } from '@/components/products/ProductEditor';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Бараа нэмэх · zahialga•' };

export default async function NewProductPage() {
  const { user, access } = await requirePage('products');
  if (access !== 'edit') redirect('/products');
  return (
    <>
      <PageHeader title="Бараа нэмэх" />
      <ProductEditor product={null} perms={{ edit: true, cost: canSeeCost(user.roles), code: canChangeProductCode(user.roles), status: canChangeProductStatus(user.roles) }} />
    </>
  );
}
