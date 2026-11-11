import { requirePage } from '@/lib/current-user';
import { SupplierClient } from '@/components/supplier/SupplierClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Нийлүүлэгч · zahialga•' };

export default async function SupplierPage() {
  const { access } = await requirePage('supplier');
  return <SupplierClient admin={access === 'edit'} />;
}
