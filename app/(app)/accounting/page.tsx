import { requirePage } from '@/lib/current-user';
import { AccountingClient } from '@/components/accounting/AccountingClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Нягтлан' };

export default async function AccountingPage() {
  await requirePage('accounting');
  return <AccountingClient />;
}
