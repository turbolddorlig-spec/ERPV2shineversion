import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePage } from '@/lib/current-user';
import { canChangeProductCode, canChangeProductStatus, canSeeCost } from '@/lib/permissions';
import { getProduct } from '@/lib/services/products';
import { AppError } from '@/lib/errors';
import { Icon } from '@/components/icons';
import { PageHeader } from '@/components/shell/AppShell';
import { ProductEditor } from '@/components/products/ProductEditor';

export const dynamic = 'force-dynamic';

export default async function ProductPage({ params, searchParams }: { params: { id: string }; searchParams: { edit?: string } }) {
  const { user, access } = await requirePage('products');
  let product;
  try {
    product = await getProduct({ id: user.id, name: user.name, roles: user.roles }, Number(params.id));
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound();
    throw e;
  }
  // Бараа дээр дарахад эхлээд харах горимоор нээгдэнэ. Засах эрхтэй хүн «Засах» товч дарж засна.
  const canEdit = access === 'edit';
  const editing = canEdit && searchParams.edit === '1';
  return (
    <>
      <PageHeader back={{ href: '/products', label: 'Бараа руу буцах' }} title={product.name} subtitle={<>Код <strong>{product.code}</strong>{access === 'view' ? ' · Танд зөвхөн харах эрх бий' : ''}</>}
        actions={canEdit && !editing ? (
          <Link href={`/products/${product.id}?edit=1`} className="inline-flex h-11 items-center gap-2 rounded-[11px] bg-accent px-5 text-[14.5px] font-bold text-on-accent">
            <Icon name="edit" size={16} /> Засах
          </Link>
        ) : null} />
      <ProductEditor product={JSON.parse(JSON.stringify(product))}
        key={editing ? 'edit' : 'view'} perms={{ edit: editing, cost: canSeeCost(user.roles), code: canChangeProductCode(user.roles), status: canChangeProductStatus(user.roles) }} />
    </>
  );
}
