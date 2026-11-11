import { requirePage } from '@/lib/current-user';
import { SalaryClient } from '@/components/salary/SalaryClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Ажилтны цалин · zahialga•' };

export default async function SalaryPage() {
  await requirePage('salary');
  return <SalaryClient />;
}
