import { requireUser } from '@/lib/current-user';
import { accessTo, visiblePages } from '@/lib/permissions';
import { ROLE_LABEL } from '@/lib/roles';
import { AppShell, type NavItem } from '@/components/shell/AppShell';
import { unreviewedCount } from '@/lib/services/product-history';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  // Шалгаагүй барааны засварын тоо — шалгах эрхтэй хүнд цэс дээр харагдана
  const pending = await unreviewedCount({ id: user.id, name: user.name, roles: user.roles }).catch(() => 0);
  const nav: NavItem[] = visiblePages(user.roles).map((p) => ({
    key: p.key, label: p.label, short: p.short, href: p.href, group: p.group, icon: p.icon,
    readOnly: accessTo(user.roles, p.key) === 'view',
    badge: p.key === 'product-history' && pending > 0 ? pending : undefined,
  }));
  return (
    <AppShell user={{ name: user.name, roleLabels: user.roles.map((r) => ROLE_LABEL[r]) }} nav={nav}>
      {children}
    </AppShell>
  );
}
