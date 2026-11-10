import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/current-user';
import { homeFor } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const user = await requireUser();
  redirect(homeFor(user.roles));
}
