import type { Role } from '@prisma/client';

export type PageKey =
  | 'dashboard' | 'orders' | 'bank-import' | 'products' | 'goods-outflow'
  | 'warehouse' | 'handover' | 'driver-lead' | 'driver' | 'driver-control' | 'issues'
  | 'accounting' | 'penalties' | 'salary' | 'my-penalties' | 'supplier'
  | 'users' | 'settings' | 'product-history' | 'loans' | 'reports';

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
  { key: 'reports', label: 'Тайлан', short: 'Тайлан', href: '/reports', group: 'Үндсэн', icon: 'chart', module: 3, edit: ['SUPER_ADMIN', 'MARKETING_LEAD', 'MARKETING'] },
  { key: 'bank-import', label: 'Банкны импорт', short: 'Банк', href: '/bank-import', group: 'Үндсэн', icon: 'bank', module: 6, edit: [...SA_A, 'OPERATOR_LEAD', 'ACCOUNTING'], view: ['OPERATOR'] },
  { key: 'products', label: 'Бараа', short: 'Бараа', href: '/products', group: 'Үндсэн', icon: 'box', module: 1, edit: [...SA_A, 'WAREHOUSE', 'MARKETING_LEAD', 'MARKETING'], view: ['PENALTY_OFFICER'] },
  { key: 'product-history', label: 'Барааны засвар', short: 'Засвар', href: '/products/history', group: 'Үндсэн', icon: 'history', module: 1,
    edit: [...SA_A, 'MARKETING_LEAD'], view: ['MARKETING', 'WAREHOUSE', 'PENALTY_OFFICER'] },
  { key: 'goods-outflow', label: 'Барааны гарц', short: 'Гарц', href: '/goods-outflow', group: 'Үндсэн', icon: 'trend', module: 7, edit: [...SA_A, 'MARKETING_LEAD', 'MARKETING'] },
  { key: 'warehouse', label: 'Агуулах', short: 'Агуулах', href: '/warehouse', group: 'Агуулах', icon: 'warehouse', module: 2, edit: [...SA_A, 'WAREHOUSE'], view: ['ACCOUNTING'] },
  { key: 'loans', label: 'Бараа зээл', short: 'Зээл', href: '/loans', group: 'Агуулах', icon: 'hand', module: 2,
    edit: [...SA_A, 'WAREHOUSE', 'ACCOUNTING', 'OPERATOR_LEAD', 'OPERATOR', 'MARKETING_LEAD', 'MARKETING', 'DRIVER_LEAD'] },
  { key: 'handover', label: 'Жолоочид бараа өгөх', short: 'Падаан', href: '/handover', group: 'Агуулах', icon: 'swap', module: 4, edit: [...SA_A, 'WAREHOUSE'], view: ['ACCOUNTING'] },
  { key: 'driver-lead', label: 'Жолооч удирдлага', short: 'Хуваарь', href: '/driver-lead', group: 'Хүргэлт', icon: 'users', module: 4, edit: [...SA_A, 'DRIVER_LEAD'] },
  { key: 'driver', label: 'Миний хүргэлт', short: 'Хүргэлт', href: '/driver', group: 'Хүргэлт', icon: 'truck', module: 5, edit: ['DRIVER'] },
  { key: 'driver-control', label: 'Жолоочийн хяналт', short: 'Хяналт', href: '/driver-control', group: 'Хүргэлт', icon: 'chart', module: 5, edit: [...SA_A, 'DRIVER_LEAD'], view: ['ACCOUNTING', 'WAREHOUSE'] },
  { key: 'issues', label: 'Асуудал', short: 'Асуудал', href: '/issues', group: 'Хүргэлт', icon: 'alert', module: 5, edit: [...SA_A, 'OPERATOR_LEAD', 'OPERATOR'], view: ['PENALTY_OFFICER'] },
  { key: 'accounting', label: 'Хүргэлт нягтлан', short: 'Тооцоо', href: '/accounting', group: 'Санхүү', icon: 'calc', module: 6, edit: [...SA_A, 'ACCOUNTING'] },
  { key: 'penalties', label: 'Алдаа удирдлага', short: 'Алдаа', href: '/penalties', group: 'Санхүү', icon: 'shield', module: 7, edit: [...SA_A, 'OPERATOR_LEAD', 'ACCOUNTING', 'PENALTY_OFFICER'] },
  { key: 'salary', label: 'Ажилтны цалин', short: 'Цалин', href: '/salary', group: 'Санхүү', icon: 'wallet', module: 7, edit: [...SA_A, 'ACCOUNTING'] },
  { key: 'supplier', label: 'Нийлүүлэгч', short: 'Нийлүүл.', href: '/supplier', group: 'Санхүү', icon: 'store', module: 7, edit: SA_A, view: ['SUPPLIER'] },
  { key: 'my-penalties', label: 'Миний торгууль', short: 'Торгууль', href: '/my-penalties', group: 'Систем', icon: 'file', module: 7,
    edit: ['SUPER_ADMIN', 'ADMIN', 'OPERATOR_LEAD', 'OPERATOR', 'DRIVER_LEAD', 'DRIVER', 'ACCOUNTING', 'WAREHOUSE', 'MARKETING_LEAD', 'MARKETING', 'PENALTY_OFFICER'] },
  { key: 'users', label: 'Хэрэглэгч', short: 'Хэрэглэгч', href: '/users', group: 'Систем', icon: 'user', module: 0, edit: [...SA_A, 'OPERATOR_LEAD', 'DRIVER_LEAD', 'MARKETING_LEAD'] },
  { key: 'settings', label: 'Тохиргоо', short: 'Тохиргоо', href: '/settings', group: 'Систем', icon: 'sliders', module: 3, edit: SA_A },
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

// ── Модуль 1: барааны нарийн эрх (шийдвэр #26–#29) ──
const has = (roles: Role[], allowed: Role[]) => roles.some((r) => allowed.includes(r));
/** Өртөг харах, засах */
export const canSeeCost = (roles: Role[]) => has(roles, SA_A);
/** Барааны код солих (шалтгаантай) */
export const canChangeProductCode = (roles: Role[]) => has(roles, SA_A);
/** Төлөв солих: Зогсоосон / Архив */
export const canChangeProductStatus = (roles: Role[]) => has(roles, [...SA_A, 'MARKETING_LEAD']);
/** Ангилал, улирлын жагсаалт удирдах */
export const canManageCatalogLists = (roles: Role[]) => has(roles, [...SA_A, 'MARKETING_LEAD']);
/** Барааны засварыг "Шалгасан" гэж тэмдэглэх */
export const canReviewProductEdits = (roles: Role[]) => has(roles, [...SA_A, 'MARKETING_LEAD']);
/** Захиалга авахдаа бараа хайх (Модуль 3) — бараа хуудас харахгүй операторт ч хэрэгтэй */
export const canSearchProducts = (roles: Role[]) => canView(roles, 'products') || canView(roles, 'orders') || canView(roles, 'driver');

// ── Модуль 2: агуулах, үлдэгдэл (шийдвэр #38–#40) ──
/** Орлого, шилжүүлэг, зарлага, тооллого оруулах, зээл олгох/хүлээн авах, тавиур */
export const canOperateStock = (roles: Role[]) => has(roles, [...SA_A, 'WAREHOUSE']);
/** Тооллого батлах, шилжүүлгийн дутагдал шийдэх, агуулах удирдах */
export const canApproveStock = (roles: Role[]) => has(roles, SA_A);
/** Бараа зээл хүсэх */
// Аудит #149 (эзний шийдвэр): ахлах жолооч зээлж болно (цалин нь «Ажилтны цалин»-д); жолооч, нийлүүлэгч — үгүй
export const canRequestLoan = (roles: Role[]) => has(roles, ['OPERATOR', 'OPERATOR_LEAD', 'MARKETING', 'MARKETING_LEAD', 'DRIVER_LEAD']) && !has(roles, ['DRIVER', 'SUPPLIER']);
/** Зээлийн хямдрал засах, цалингаас суутгах гэж тэмдэглэх */
export const canLoanFinance = (roles: Role[]) => has(roles, ['SUPER_ADMIN', 'ACCOUNTING']);
/** Бүх ажилтны зээлийг харах */
export const canSeeAllLoans = (roles: Role[]) => has(roles, [...SA_A, 'WAREHOUSE', 'ACCOUNTING']);

// ── Модуль 3: захиалга (шийдвэр #43–#54) ──
/** Захиалга үүсгэх, засах, цуцлах — бүх оператор бүх захиалгыг (хуучин шиг, #43 7) */
export const canEditOrders = (roles: Role[]) => canEdit(roles, 'orders');
/** «Мөнгө орсон», буцаах, төлбөрийн хугацаа сунгах */
export const canMarkPaid = (roles: Role[]) => has(roles, [...SA_A, 'OPERATOR_LEAD']);
/** Хар жагсаалт удирдах, пэйж хуваарилах, дуудлагыг шууд шилжүүлэх */
export const canSuperviseOperators = (roles: Role[]) => has(roles, [...SA_A, 'OPERATOR_LEAD']);
/** Үнийн хөнгөлөлт, хүргэлтийн төлбөрийн өөрчлөлтийг «Шалгасан» (#43 2) */
export const canReviewDiscounts = (roles: Role[]) => has(roles, ['SUPER_ADMIN']);
/** Хүргэлтийн төлбөр, хүлээх хоног, пэйж, Meta Pixel тохиргоо */
export const canManageOrderSettings = (roles: Role[]) => has(roles, SA_A);
// ───── Модуль 4: падаан ─────
/** Жолоочид захиалга хуваарилах, огноо солих (ахлах жолооч, админ) */
export const canAssignDrivers = (roles: Role[]) => canEdit(roles, 'driver-lead');
/** Падаан үүсгэх, бэлтгэх, бараа өгөх (агуулах, админ) */
export const canOperateHandover = (roles: Role[]) => canEdit(roles, 'handover');
/** Нягтлангийн OKEY / ХОРИГ (хуучин ERP шиг) */
export const canApproveDrivers = (roles: Role[]) => has(roles, [...SA_A, 'ACCOUNTING']);
// ───── Модуль 5: жолооч ─────
/** Жолоочийн апп: хүргэсэн, цуцлах, маргааш, асуудал, өөрөө авах, нэмэлт бараа */
export const canDrive = (roles: Role[]) => canEdit(roles, 'driver');
/** «Опп-руу явуулах» асуудлыг шийдэх (зассан / цуцлах) — ахлах оператор, админ */
export const canResolveIssues = (roles: Role[]) => has(roles, [...SA_A, 'OPERATOR_LEAD']);
/** Жолоочоос буцаалт хүлээн авах — агуулах, админ */
export const canReceiveReturns = (roles: Role[]) => canOperateStock(roles);
// ───── Модуль 6: нягтлан (#82, #83) ─────
/** Тооцоо баталгаажуулах, гүйцэтгэл гараар засах, төлөв солих, өр нэмэх/хасах, урьдчилгаа зөвшөөрөх */
export const canAccount = (roles: Role[]) => canEdit(roles, 'accounting');
/** «Гүйцэтгэл солих» (тусгай / орон нутаг) ба цалингийн дүрэм (хөлс, босго) — зөвхөн Супер админ (хуучин шиг) */
export const canManagePay = (roles: Role[]) => has(roles, ['SUPER_ADMIN']);
/** Банкны хуулга импортлох, тааруулах, «Буцаасан» тэмдэглэх */
export const canBankImport = (roles: Role[]) => canEdit(roles, 'bank-import');
