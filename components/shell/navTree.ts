import type { NavItem } from './AppShell';

/**
 * Цэсийн бүтэц (эзний шийдвэр #130): үндсэн мөр + доор нь жижиг догол мөрүүд.
 * Харах эсэх нь `lib/permissions.ts`-ээс (nav-д ирсэн хуудсууд л). Хуудасны эрх, хаяг өөрчлөгдөхгүй.
 */
type TreeDef = { key: string; children?: string[] } | { group: string; icon: string; children: string[] };
const TREE: TreeDef[] = [
  { key: 'dashboard' },
  { key: 'goods-outflow' },
  { key: 'orders', children: ['bank-import', 'reports', 'issues'] },
  { key: 'products', children: ['product-history'] },
  { key: 'warehouse', children: ['loans', 'handover'] },
  { group: 'Хүргэлт', icon: 'truck', children: ['driver-lead', 'driver-control', 'driver'] },
  { group: 'Санхүү', icon: 'wallet', children: ['accounting', 'salary', 'penalties', 'supplier'] },
  { group: 'Систем', icon: 'sliders', children: ['users', 'settings', 'my-penalties'] },
];
/** Догол мөрийн богино нэр */
export const SUB_LABEL: Record<string, string> = {
  'bank-import': 'Банк', reports: 'Тайлан', issues: 'Асуудал', 'product-history': 'Барааны засвар', loans: 'Бараа зээл', handover: 'Падаан',
  'driver-lead': 'Хуваарилалт', 'driver-control': 'Жолоочийн хяналт', driver: 'Миний хүргэлт', accounting: 'Тооцоо', salary: 'Цалин',
  penalties: 'Алдаа', supplier: 'Нийлүүлэгч', users: 'Хэрэглэгч', settings: 'Тохиргоо', 'my-penalties': 'Миний торгууль',
};
export interface NavNode { id: string; label: string; icon: string; href: string; item: NavItem | null; children: NavItem[]; badge: number }

export function buildTree(nav: NavItem[]): NavNode[] {
  const by = new Map(nav.map((n) => [n.key, n]));
  const used = new Set<string>();
  const out: NavNode[] = [];
  const sum = (xs: (NavItem | null | undefined)[]) => xs.reduce((s, x) => s + (x?.badge ?? 0), 0);
  for (const t of TREE) {
    const kids = (t.children ?? []).map((k) => by.get(k)).filter((x): x is NavItem => !!x);
    kids.forEach((k) => used.add(k.key));
    if ('key' in t) {
      const self = by.get(t.key);
      if (self) {
        used.add(self.key);
        out.push({ id: self.key, label: self.label, icon: self.icon, href: self.href, item: self, children: kids, badge: sum([self, ...kids]) });
      } else {
        // Эцэг хуудас эрхгүй бол хүүхдүүд нь үндсэн мөр болно
        for (const k of kids) out.push({ id: k.key, label: k.label, icon: k.icon, href: k.href, item: k, children: [], badge: k.badge ?? 0 });
      }
    } else if (kids.length === 1) {
      const k = kids[0]!;
      out.push({ id: k.key, label: k.label, icon: k.icon, href: k.href, item: k, children: [], badge: k.badge ?? 0 });
    } else if (kids.length > 1) {
      out.push({ id: `g:${t.group}`, label: t.group, icon: t.icon, href: kids[0]!.href, item: null, children: kids, badge: sum(kids) });
    }
  }
  // Бүтцэд ороогүй шинэ хуудас — алдагдахгүй
  for (const n of nav) if (!used.has(n.key)) out.push({ id: n.key, label: n.label, icon: n.icon, href: n.href, item: n, children: [], badge: n.badge ?? 0 });
  return out;
}
