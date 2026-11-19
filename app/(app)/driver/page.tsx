import { requirePage } from '@/lib/current-user';
import { DriverClient } from '@/components/delivery/DriverClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Миний хүргэлт' };

export default async function DriverPage() {
  await requirePage('driver');
  return <DriverClient />;
}
