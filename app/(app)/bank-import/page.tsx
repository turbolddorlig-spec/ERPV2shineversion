import { requirePage } from '@/lib/current-user';
import { BankImportClient } from '@/components/accounting/BankImportClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Банкны импорт · zahialga•' };

export default async function BankImportPage() {
  await requirePage('bank-import');
  return <BankImportClient />;
}
