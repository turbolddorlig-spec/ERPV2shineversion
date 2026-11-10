import { notFound } from 'next/navigation';
import { requirePage } from '@/lib/current-user';
import { canChangeProductCode, canChangeProductStatus, canSeeCost } from '@/lib/permissions';
import { getProduct } from '@/lib/services/products';
import { AppError } from '@/lib/errors';
import { PageHeader } from '@/components/shell/AppShell';
import { ProductEditor } from '@/components/products/ProductEditor';

export const dynamic = 'force-dynamic';

export default async function ProductPage({ params }: { params: { id: string } }) {
  const { user, access } = await requirePage('products');
  let product;
  try {
    product = await getProduct({ id: user.id, name: user.name, roles: user.roles }, Number(params.id));
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound();
    throw e;
  }
  return (
    <>
      <PageHeader title={product.name} subtitle={<>Код <strong>{product.code}</strong>{access === 'view' ? ' · Танд зөвхөн харах эрх бий' : ''}</>} />
      <ProductEditor product={JSON.parse(JSON.stringify(product))}
        perms={{ edit: access === 'edit', cost: canSeeCost(user.roles), code: canChangeProductCode(user.roles), status: canChangeProductStatus(user.roles) }} />
    </>
  );
}
