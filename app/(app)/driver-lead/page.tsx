import { requirePage } from '@/lib/current-user';
import { DriverLeadClient } from '@/components/delivery/DriverLeadClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Ахлах жолооч' };

export default async function DriverLeadPage() {
  await requirePage('driver-lead');
  return <DriverLeadClient />;
}
