import { requirePage } from '@/lib/current-user';
import { isAdmin, manageableRoles, ROLE_LABEL } from '@/lib/roles';
import { PageHeader } from '@/components/shell/AppShell';
import { UsersClient } from './UsersClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Хэрэглэгч · zahialga•' };

export default async function UsersPage() {
  const { user } = await requirePage('users');
  const roles = manageableRoles(user.roles).map((r) => ({ value: r, label: ROLE_LABEL[r] }));
  return (
    <>
      <PageHeader title="Хэрэглэгч" subtitle={isAdmin(user.roles) ? 'Бүх ажилтны эрх, нэвтрэлт' : `Таны хариуцсан: ${roles.map((r) => r.label).join(', ')}`} />
      <UsersClient assignable={roles} canUnlock={isAdmin(user.roles)} selfId={user.id} />
    </>
  );
}
