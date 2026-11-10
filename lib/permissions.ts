import type { Role } from '@prisma/client';

export type PageKey =
  | 'dashboard' | 'orders' | 'bank-import' | 'products' | 'goods-outflow'
  | 'warehouse' | 'handover' | 'driver-lead' | 'driver' | 'issues'
  | 'accounting' | 'penalties' | 'salary' | 'my-penalties' | 'supplier'
  | 'users' | 'settings';

export type Group = 'Үндсэн' | 'Агуулах' | 'Хүргэлт' | 'Санхүү' | 'Систем';

export interface PageDef {
  key: PageKey;
  label: string;
  /** Rail дээрх богино нэр */
  short: string;
  href: string;
  group: Group;
  icon: string;
  /** Аль модульд бүтээгдэх вэ (0 = одоо) */
  module: number;
  /** Харж, ажиллах эрхтэй */
  edit: Role[];
  /** Зөвхөн харах эрхтэй */
  view?: Role[];
}

const SA_A: Role[] = ['SUPER_ADMIN', 'ADMIN'];

/**
 * Хэн юу харах вэ — Модуль 0-ийн батлагдсан эрхийн хүснэгт.
 * Энэ бол эрхийн ГАНЦ эх сурвалж: цэс ч, сервер талын шалгалт ч үүнээс уншина.
 */
export const PAGES: PageDef[] = [
  { key: 'dashboard', label: 'Хянах самбар', short: 'Хянах', href: '/dashboard', group: 'Үндсэн', icon: 'chart', module: 7, edit: SA_A },
  { key: 'orders', label: 'Захиалга', short: 'Захиалга', href: '/orders', group: 'Үндсэн', icon: 'flow', module: 3, edit: [...SA_A, 'OPERATOR_LEAD', 'OPERATOR'], view: ['PENALTY_OFFICER'] },
  { key: 'bank-import', label: 'Банкны импорт', short: 'Банк', href: '/bank-import', group: 'Үндсэн', icon: 'bank', module: 6, edit: [...SA_A, 'OPERATOR_LEAD', 'OPERATOR'] },
  { key: 'products', label: 'Бараа', short: 'Бараа', href: '/products', group: 'Үндсэн', icon: 'box', module: 1, edit: [...SA_A, 'WAREHOUSE', 'MARKETING_LEAD', 'MARKETING'], view: ['PENALTY_OFFICER'] },
  { key: 'goods-outflow', label: 'Барааны гарц', short: 'Гарц', href: '/goods-outflow', group: 'Үндсэн', icon: 'trend', module: 7, edit: [...SA_A, 'MARKETING_LEAD', 'MARKETING'] },
  { key: 'warehouse', label: 'Агуулах', short: 'Агуулах', href: '/warehouse', group: 'Агуулах', icon: 'warehouse', module: 2, edit: [...SA_A, 'WAREHOUSE'], view: ['ACCOUNTING'] },
  { key: 'handover', label: 'Жолоочид бараа өгөх', short: 'Падаан', href: '/handover', group: 'Агуулах', icon: 'swap', module: 4, edit: [...SA_A, 'WAREHOUSE'], view: ['ACCOUNTING'] },
  { key: 'driver-lead', label: 'Жолооч удирдлага', short: 'Хуваарь', href: '/driver-lead', group: 'Хүргэлт', icon: 'users', module: 4, edit: [...SA_A, 'DRIVER_LEAD'] },
  { key: 'driver', label: 'Миний хүргэлт', short: 'Хүргэлт', href: '/driver', group: 'Хүргэлт', icon: 'truck', module: 5, edit: ['DRIVER'] },
  { key: 'issues', label: 'Асуудал', short: 'Асуудал', href: '/issues', group: 'Хүргэлт', icon: 'alert', module: 7, edit: [...SA_A, 'OPERATOR_LEAD', 'OPERATOR'], view: ['PENALTY_OFFICER'] },
  { key: 'accounting', label: 'Хүргэлт нягтлан', short: 'Тооцоо', href: '/accounting', group: 'Санхүү', icon: 'calc', module: 6, edit: [...SA_A, 'ACCOUNTING'] },
  { key: 'penalties', label: 'Алдаа удирдлага', short: 'Алдаа', href: '/penalties', group: 'Санхүү', icon: 'shield', module: 7, edit: [...SA_A, 'OPERATOR_LEAD', 'ACCOUNTING', 'PENALTY_OFFICER'] },
  { key: 'salary', label: 'Ажилтны цалин', short: 'Цалин', href: '/salary', group: 'Санхүү', icon: 'wallet', module: 7, edit: [...SA_A, 'ACCOUNTING'] },
  { key: 'supplier', label: 'Нийлүүлэгч', short: 'Нийлүүл.', href: '/supplier', group: 'Санхүү', icon: 'store', module: 7, edit: ['SUPER_ADMIN'], view: ['SUPPLIER'] },
  { key: 'my-penalties', label: 'Миний торгууль', short: 'Торгууль', href: '/my-penalties', group: 'Систем', icon: 'file', module: 7,
    edit: ['SUPER_ADMIN', 'ADMIN', 'OPERATOR_LEAD', 'OPERATOR', 'DRIVER_LEAD', 'DRIVER', 'ACCOUNTING', 'WAREHOUSE', 'MARKETING_LEAD', 'MARKETING', 'PENALTY_OFFICER'] },
  { key: 'users', label: 'Хэрэглэгч', short: 'Хэрэглэгч', href: '/users', group: 'Систем', icon: 'user', module: 0, edit: [...SA_A, 'OPERATOR_LEAD', 'DRIVER_LEAD', 'MARKETING_LEAD'] },
  { key: 'settings', label: 'Тохиргоо', short: 'Тохиргоо', href: '/settings', group: 'Систем', icon: 'sliders', module: 7, edit: SA_A },
];

export type Access = 'none' | 'view' | 'edit';

export function pageByKey(key: string): PageDef | undefined {
  return PAGES.find((p) => p.key === key);
}

/** Олон role-тэй бол хамгийн өндөр эрх нь хүчинтэй (шийдвэр #18). */
export function accessTo(roles: Role[], key: PageKey): Access {
  const page = pageByKey(key);
  if (!page) return 'none';
  if (roles.some((r) => page.edit.includes(r))) return 'edit';
  if (roles.some((r) => page.view?.includes(r))) return 'view';
  return 'none';
}

export function canView(roles: Role[], key: PageKey): boolean {
  return accessTo(roles, key) !== 'none';
}

export function canEdit(roles: Role[], key: PageKey): boolean {
  return accessTo(roles, key) === 'edit';
}

export function visiblePages(roles: Role[]): PageDef[] {
  return PAGES.filter((p) => canView(roles, p.key));
}

/** Нэвтэрсний дараа хаашаа орох вэ */
export function homeFor(roles: Role[]): string {
  const order: PageKey[] = ['dashboard', 'orders', 'driver', 'handover', 'warehouse', 'accounting', 'driver-lead', 'products', 'goods-outflow', 'penalties', 'supplier', 'users'];
  for (const k of order) if (canView(roles, k)) return pageByKey(k)!.href;
  return '/me';
}
