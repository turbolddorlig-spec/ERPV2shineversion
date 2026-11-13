import { requireUser } from '@/lib/current-user';
import { accessTo, visiblePages } from '@/lib/permissions';
import { ROLE_LABEL } from '@/lib/roles';
import { AppShell, type NavItem } from '@/components/shell/AppShell';
import { unreviewedCount } from '@/lib/services/product-history';
import { reconcileAlert, warehouseBadge } from '@/lib/services/stock/views';
import { pendingIssueCount } from '@/lib/services/delivery/driver';
import { canView } from '@/lib/permissions';
import { unreviewedDiscounts } from '@/lib/services/orders/queries';
import { canReviewDiscounts } from '@/lib/permissions';
import { alertBanner, reorderBanner } from '@/lib/services/outflow';
import { supplierReorderBanner } from '@/lib/services/supplier-outflow';
import { unassignedAlert } from '@/lib/services/delivery/assign';
import { staleHandoverAlert } from '@/lib/services/delivery/handover';
import { jobsAlert } from '@/lib/jobs';
import { backupAlert } from '@/lib/services/backup-status';
import { shortageSkipAlert } from '@/lib/services/accounting/debts';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  // Шалгаагүй барааны засварын тоо — шалгах эрхтэй хүнд цэс дээр харагдана
  const actor = { id: user.id, name: user.name, roles: user.roles };
  // Агуулахын «Өнөөдрийн ажил»-ын тоо (дүүргэх, ирэх шилжүүлэг, зээлийн хүсэлт, батлах тооллого)
  const [pending, whWork, discounts, recAlert, issues, boost, reorder, unassigned, jobs, skip, backup, staleHo] = await Promise.all([
    unreviewedCount(actor).catch(() => 0),
    warehouseBadge(actor).catch(() => 0),
    // Супер админд: шалгаагүй үнийн хөнгөлөлт / хүргэлтийн өөрчлөлт (#43 2)
    canReviewDiscounts(user.roles) ? unreviewedDiscounts().catch(() => 0) : Promise.resolve(0),
    // Супер админд: автомат тулгалтын зөрүү (B2/R2)
    reconcileAlert(user.roles).catch(() => null),
    // Модуль 5: шийдээгүй «Опп-руу явуулах»
    canView(user.roles, 'issues') ? pendingIssueCount().catch(() => 0) : Promise.resolve(0),
    // Модуль 7г: алдагдалтай / ашиг багассан бүүст (СА, Админ, маркетинг)
    alertBanner(user.roles).catch(() => null),
    // #119: бараа татах (нөөц ≤ ирэх хоног) — зөвхөн Супер админд
    user.roles.includes('SUPPLIER') ? supplierReorderBanner(actor).catch(() => null) : reorderBanner(user.roles).catch(() => null),
    // #124-4: хуваарилагдаагүй «Шинэ» захиалга (хоносон / тохиргооны цагаас хойш)
    unassignedAlert(user.roles).catch(() => null),
    // Аудит №1: арын ажил 10+ мин ажиллаагүй (СА); шөнийн өр хоцорч алгасагдсан (СА, нягтлан)
    jobsAlert(user.roles).catch(() => null),
    shortageSkipAlert(user.roles).catch(() => null),
    // #132: нөөц хуулбар (26+ цаг, алдаа, Drive) — СА
    backupAlert(user.roles).catch(() => null),
    // Аудит #147: агуулах өгсөн, жолооч 2 цагаас удаан хүлээн аваагүй падаан (агуулах, ахлах жолооч, СА, Админ)
    staleHandoverAlert(user.roles).catch(() => null),
  ]);
  const nav: NavItem[] = visiblePages(user.roles).map((p) => ({
    key: p.key, label: p.label, short: p.short, href: p.href, group: p.group, icon: p.icon,
    readOnly: accessTo(user.roles, p.key) === 'view',
    badge: p.key === 'product-history' && pending > 0 ? pending : p.key === 'warehouse' && whWork > 0 ? whWork : p.key === 'orders' && discounts > 0 ? discounts : p.key === 'issues' && issues > 0 ? issues : undefined,
  }));
  return (
    <AppShell user={{ name: user.name, roleLabels: user.roles.map((r) => ROLE_LABEL[r]) }} nav={nav}
      jobsAlert={jobs} shortageSkip={skip} backupAlert={backup} boostAlert={boost} reorderAlert={reorder} assignAlert={unassigned} handoverAlert={staleHo} reorderHref={user.roles.includes('SUPPLIER') ? '/supplier' : '/goods-outflow?tab=reorder'}
      alert={recAlert ? { kind: recAlert.kind, count: recAlert.status?.count ?? 0, at: recAlert.status?.at ?? null, since: recAlert.status?.since ?? null } : null}>
      {children}
    </AppShell>
  );
}
