import { requireUser } from '@/lib/current-user';
import { accessTo, visiblePages } from '@/lib/permissions';
import { ROLE_LABEL } from '@/lib/roles';
import { AppShell, type NavItem } from '@/components/shell/AppShell';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const nav: NavItem[] = visiblePages(user.roles).map((p) => ({
    key: p.key, label: p.label, short: p.short, href: p.href, group: p.group, icon: p.icon,
    readOnly: accessTo(user.roles, p.key) === 'view',
  }));
  return (
    <AppShell user={{ name: user.name, roleLabels: user.roles.map((r) => ROLE_LABEL[r]) }} nav={nav}>
      {children}
    </AppShell>
  );
}
