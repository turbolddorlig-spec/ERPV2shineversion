import { requireUser } from '@/lib/current-user';
import { accessTo, visiblePages } from '@/lib/permissions';
import { ROLE_LABEL } from '@/lib/roles';
import { AppShell, type NavItem } from '@/components/shell/AppShell';
import { unreviewedCount } from '@/lib/services/product-history';
import { warehouseBadge } from '@/lib/services/stock/views';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  // Шалгаагүй барааны засварын тоо — шалгах эрхтэй хүнд цэс дээр харагдана
  const actor = { id: user.id, name: user.name, roles: user.roles };
  // Агуулахын «Өнөөдрийн ажил»-ын тоо (дүүргэх, ирэх шилжүүлэг, зээлийн хүсэлт, батлах тооллого)
  const [pending, whWork] = await Promise.all([
    unreviewedCount(actor).catch(() => 0),
    warehouseBadge(actor).catch(() => 0),
  ]);
  const nav: NavItem[] = visiblePages(user.roles).map((p) => ({
    key: p.key, label: p.label, short: p.short, href: p.href, group: p.group, icon: p.icon,
    readOnly: accessTo(user.roles, p.key) === 'view',
    badge: p.key === 'product-history' && pending > 0 ? pending : p.key === 'warehouse' && whWork > 0 ? whWork : undefined,
  }));
  return (
    <AppShell user={{ name: user.name, roleLabels: user.roles.map((r) => ROLE_LABEL[r]) }} nav={nav}>
      {children}
    </AppShell>
  );
}
