import { requirePage } from '@/lib/current-user';
import { DriverControlClient } from '@/components/delivery/DriverControlClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Жолоочийн хяналт · zahialga•' };

export default async function DriverControlPage() {
  await requirePage('driver-control');
  return <DriverControlClient />;
}
