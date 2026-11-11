import type { PenaltyType, Prisma, Role } from '@prisma/client';
import { db } from '../db';
import { badRequest, conflict, forbidden, notFound } from '../errors';
import { writeAudit, type Actor } from '../audit';
import { canEdit, canView } from '../permissions';
import { isYmd, ubDay, ubDayStart } from '../ubdate';
import { addDays } from './delivery/core';
import type { UserActor } from './users';

type Tx = Prisma.TransactionClient;

/**
 * Модуль 7а — Алдаа удирдлага (#90, хуучин «/salary-accounting» шиг):
 *   торгууль гараар тавих (алдааны нэр — тохиргооны жагсаалтаас, хэрэглэгч шинээр үүсгэнэ), шалтгаантай «Цуцлах» (устгахгүй),
 *   «Цалингаас хассан» тэмдэг (Ажилтны цалин модуль автоматаар тэмдэглэнэ — давхар харагдана), «Миний торгууль».
 *   Автомат: «Опп-руу явуулах» асуудлыг «Цуцлах» үед хэний алдаагаар — Опп → захиалга авсан ажилтан, Маркетинг → захиалга авсан маркетинг,
 *   Агуулах → падаан бэлдсэн ажилтан; Жолоочийн алдаа → торгуульгүй (хуучин шиг). Дүн тохиргооноос (анх 5,000₮).
 */
export const PENALTY_TYPE_LABEL: Record<PenaltyType, string> = { OPP_ERROR: 'Опп-н алдаа', DELIVERY_ERROR: 'Хүргэлтийн алдаа', MARKETING_ERROR: 'Маркетингийн алдаа', WAREHOUSE_ERROR: 'Агуулахын алдаа' };
const TYPES = Object.keys(PENALTY_TYPE_LABEL) as PenaltyType[];

export interface PenaltyCategory { id: string; type: PenaltyType; name: string; defaultAmount: number; active: boolean; lateMinutes?: boolean }
export interface PenaltyConfig { autoAmount: Record<'OPP_ERROR' | 'MARKETING_ERROR' | 'WAREHOUSE_ERROR', number>; categories: PenaltyCategory[] }
const KEY = 'penalty.config';
/** Хуучин ERP-ийн жагсаалт (анхдагч) */
const DEFAULT_CONFIG: PenaltyConfig = {
  autoAmount: { OPP_ERROR: 5000, MARKETING_ERROR: 5000, WAREHOUSE_ERROR: 5000 },
  categories: [
    { id: 'opp-comment', type: 'OPP_ERROR', name: 'Коммент шүүгээгүй', defaultAmount: 5000, active: true },
    { id: 'opp-chat', type: 'OPP_ERROR', name: 'Чат шүүгээгүй', defaultAmount: 5000, active: true },
    { id: 'opp-number', type: 'OPP_ERROR', name: 'Дугаар үлдээсэн', defaultAmount: 5000, active: true },
    { id: 'opp-share', type: 'OPP_ERROR', name: 'Шэйр хийгээгүй', defaultAmount: 5000, active: true },
    { id: 'opp-3calls', type: 'OPP_ERROR', name: '3 удаа залгаагүй', defaultAmount: 5000, active: true },
    { id: 'drv-share', type: 'DELIVERY_ERROR', name: 'Шэйр хийгээгүй', defaultAmount: 5000, active: true },
    { id: 'drv-late', type: 'DELIVERY_ERROR', name: 'Хоцролт', defaultAmount: 5000, active: true, lateMinutes: true },
  ],
};
const ISSUE_TEXT: Record<string, string> = { WRONG_PRODUCT: 'Бараа буруу', WRONG_NUMBER: 'Дугаар буруу', UNCLEAR_ADDRESS: 'Хаяг тодорхойгүй' };

const canManage = (r: Role[]) => canEdit(r, 'penalties');
const canDeduct = (r: Role[]) => r.some((x) => ['SUPER_ADMIN', 'ADMIN', 'ACCOUNTING'].includes(x));
const canAutoAmount = (r: Role[]) => canEdit(r, 'settings');
/** Ролоос торгуулийн анхдагч төрөл */
export function typeForRoles(roles: Role[]): PenaltyType | null {
  if (roles.some((r) => r === 'OPERATOR' || r === 'OPERATOR_LEAD')) return 'OPP_ERROR';
  if (roles.some((r) => r === 'DRIVER' || r === 'DRIVER_LEAD')) return 'DELIVERY_ERROR';
  if (roles.some((r) => r === 'MARKETING' || r === 'MARKETING_LEAD')) return 'MARKETING_ERROR';
  if (roles.includes('WAREHOUSE')) return 'WAREHOUSE_ERROR';
  return null;
}

export async function readPenaltyConfig(tx: Tx | typeof db = db): Promise<PenaltyConfig> {
  const s = await tx.appSetting.findUnique({ where: { key: KEY } });
  const v = (s?.value ?? {}) as Partial<PenaltyConfig>;
  return { autoAmount: { ...DEFAULT_CONFIG.autoAmount, ...(v.autoAmount ?? {}) }, categories: v.categories ?? DEFAULT_CONFIG.categories };
}
async function saveConfig(c: PenaltyConfig, actor: UserActor) {
  await db.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: c as unknown as Prisma.InputJsonValue, updatedById: actor.id }, update: { value: c as unknown as Prisma.InputJsonValue, updatedById: actor.id } });
}
const cleanAmount = (v: unknown, label = 'Дүн') => { const n = Number(v); if (!Number.isInteger(n) || n <= 0 || n > 10_000_000) throw badRequest(`${label} буруу`); return n; };
const cleanType = (v: unknown) => { const t = String(v ?? '') as PenaltyType; if (!TYPES.includes(t)) throw badRequest('Алдааны төрлөө сонгоно уу'); return t; };

// ───────────────────────── Алдааны нэр (хэрэглэгч шинээр үүсгэнэ) ─────────────────────────

export async function penaltyConfig(actor: UserActor) {
  if (!canView(actor.roles, 'penalties') && !canEdit(actor.roles, 'settings')) throw forbidden();
  return { ...(await readPenaltyConfig()), types: TYPES.map((t) => ({ type: t, label: PENALTY_TYPE_LABEL[t] })), canManage: canManage(actor.roles), canAutoAmount: canAutoAmount(actor.roles) };
}

/** Алдааны нэр нэмэх / засах (нэр, анхдагч дүн, идэвхтэй) — Алдаа удирдлагын эрхтэй хүн */
export async function saveCategory(actor: UserActor, input: { id?: unknown; type?: unknown; name?: unknown; defaultAmount?: unknown; active?: unknown; lateMinutes?: unknown }) {
  if (!canManage(actor.roles)) throw forbidden('Алдааны нэрийг Алдаа удирдлагын эрхтэй хүн үүсгэнэ');
  const c = await readPenaltyConfig();
  const name = String(input.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (name.length < 2) throw badRequest('Алдааны нэрийг бичнэ үү', 'name_required');
  const defaultAmount = cleanAmount(input.defaultAmount, 'Анхдагч дүн');
  const id = String(input.id ?? '');
  const cur = id ? c.categories.find((x) => x.id === id) : undefined;
  if (id && !cur) throw notFound('Алдааны нэр олдсонгүй');
  const type = cur ? cur.type : cleanType(input.type);
  if (c.categories.some((x) => x.type === type && x.id !== id && x.name.toLowerCase() === name.toLowerCase())) throw conflict('Ийм нэртэй алдаа байна', 'duplicate');
  const next: PenaltyCategory = { id: cur?.id ?? `c${Date.now().toString(36)}`, type, name, defaultAmount, active: input.active === undefined ? cur?.active ?? true : input.active === true, lateMinutes: input.lateMinutes === undefined ? cur?.lateMinutes : input.lateMinutes === true };
  c.categories = cur ? c.categories.map((x) => (x.id === id ? next : x)) : [...c.categories, next];
  if (c.categories.length > 200) throw badRequest('Хэт олон алдааны нэр');
  await saveConfig(c, actor);
  await writeAudit(actor, cur ? 'penalty.category_updated' : 'penalty.category_created', 'AppSetting', KEY, { type, name, defaultAmount, active: next.active, ...(cur ? { from: { name: cur.name, defaultAmount: cur.defaultAmount, active: cur.active } } : {}) }, db, ['settings', 'penalty']);
  return next;
}

/** Автомат торгуулийн дүн (Тохиргоо) */
export async function setAutoAmounts(actor: UserActor, input: Record<string, unknown>) {
  if (!canAutoAmount(actor.roles)) throw forbidden('Автомат торгуулийн дүнг админ тохируулна');
  const c = await readPenaltyConfig();
  const before = { ...c.autoAmount };
  for (const k of ['OPP_ERROR', 'MARKETING_ERROR', 'WAREHOUSE_ERROR'] as const) if (input[k] !== undefined) c.autoAmount[k] = cleanAmount(input[k], PENALTY_TYPE_LABEL[k]);
  await saveConfig(c, actor);
  await writeAudit(actor, 'penalty.auto_amount', 'AppSetting', KEY, { from: before, to: c.autoAmount }, db, ['settings', 'penalty', 'money']);
  return c.autoAmount;
}

// ───────────────────────── Торгууль ─────────────────────────

const serialize = (p: Prisma.PenaltyGetPayload<object>) => ({ ...p, typeLabel: PENALTY_TYPE_LABEL[p.type] });

export async function createPenalty(actor: UserActor, input: { userId?: unknown; type?: unknown; categoryId?: unknown; customName?: unknown; amount?: unknown; description?: unknown; orderNumber?: unknown; pageName?: unknown; customerPhone?: unknown; customerName?: unknown; lateMinutes?: unknown }) {
  if (!canManage(actor.roles)) throw forbidden('Торгуулийг Алдаа удирдлагын эрхтэй хүн тавина');
  const userId = String(input.userId ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw badRequest('Ажилтнаа сонгоно уу', 'user_required');
  const u = await db.user.findUnique({ where: { id: userId }, select: { id: true, name: true, roles: true, isActive: true } });
  if (!u) throw notFound('Ажилтан олдсонгүй');
  const type = cleanType(input.type ?? typeForRoles(u.roles));
  const cfg = await readPenaltyConfig();
  const cat = input.categoryId ? cfg.categories.find((c) => c.id === String(input.categoryId) && c.active) : undefined;
  if (input.categoryId && !cat) throw badRequest('Алдааны нэр олдсонгүй (идэвхгүй болсон байж магадгүй)');
  const category = cat ? cat.name : String(input.customName ?? '').trim().slice(0, 80);
  if (category.length < 2) throw badRequest('Алдааны нэрээ сонгох эсвэл бичнэ үү', 'category_required');
  const amount = cleanAmount(input.amount);
  const lateMinutes = input.lateMinutes === undefined || input.lateMinutes === '' || input.lateMinutes === null ? null : Number(input.lateMinutes);
  if (lateMinutes !== null && (!Number.isInteger(lateMinutes) || lateMinutes < 1 || lateMinutes > 1440)) throw badRequest('Хоцорсон минут буруу');
  const s = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n) || null;
  const orderNumber = s(input.orderNumber, 20);
  const order = orderNumber ? await db.order.findUnique({ where: { number: orderNumber }, select: { id: true } }) : null;
  if (orderNumber && !order) throw badRequest('Захиалгын дугаар олдсонгүй', 'order_not_found');
  const p = await db.$transaction(async (tx) => {
    const p = await tx.penalty.create({ data: {
      type, category: lateMinutes ? `${category} (${lateMinutes} мин)` : category, amount, description: s(input.description, 500), userId, userName: u.name,
      orderId: order?.id ?? null, orderNumber, pageName: s(input.pageName, 120), customerPhone: s(input.customerPhone, 20), customerName: s(input.customerName, 120), lateMinutes,
      createdById: actor.id, createdByName: actor.name,
    } });
    await writeAudit(actor, 'penalty.created', 'Penalty', String(p.id), { user: u.name, type, category: p.category, amount, orderNumber }, tx, ['penalty', 'money']);
    return p;
  });
  return serialize(p);
}

export async function cancelPenalty(actor: UserActor, idIn: unknown, input: { note?: unknown }) {
  if (!canManage(actor.roles)) throw forbidden();
  const id = Number(idIn);
  const note = String(input.note ?? '').trim().slice(0, 300);
  if (note.length < 3) throw badRequest('Цуцлах шалтгаанаа бичнэ үү', 'reason_required');
  return db.$transaction(async (tx) => {
    const p = await tx.penalty.findUnique({ where: { id } });
    if (!p) throw notFound('Торгууль олдсонгүй');
    if (p.status === 'CANCELLED') return { penalty: serialize(p), duplicate: true };
    if (p.deducted) throw conflict('Цалингаас хасагдсан торгууль — эхлээд цалингийн тооцоонд засна', 'deducted');
    // Хэсэгчлэн суутгагдсан (#124-Е1): бүхэлд нь цуцлахгүй — зөвхөн суутгаагүй үлдэгдлийг цуцална (суутгасан дүн хэвээр)
    if (p.deductedAmount > 0) {
      const n = await tx.penalty.updateMany({ where: { id, status: 'ACTIVE', deducted: false, deductedAmount: p.deductedAmount },
        data: { amount: p.deductedAmount, deducted: true, deductedAt: new Date(), deductedByName: `${actor.name} (үлдэгдэл цуцалсан)`, cancelNote: note, version: { increment: 1 } } });
      if (!n.count) throw conflict('Торгууль өөрчлөгдсөн байна — дахин ачаална уу', 'stale');
      await writeAudit(actor, 'penalty.remaining_cancelled', 'Penalty', String(id), { user: p.userName, category: p.category, amount: p.amount, deducted: p.deductedAmount, cancelled: p.amount - p.deductedAmount, note }, tx, ['penalty', 'money']);
      return { penalty: serialize(await tx.penalty.findUniqueOrThrow({ where: { id } })), duplicate: false };
    }
    const n = await tx.penalty.updateMany({ where: { id, status: 'ACTIVE', deducted: false }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledByName: actor.name, cancelNote: note, version: { increment: 1 } } });
    if (!n.count) throw conflict('Торгууль өөрчлөгдсөн байна — дахин ачаална уу', 'stale');
    await writeAudit(actor, 'penalty.cancelled', 'Penalty', String(id), { user: p.userName, category: p.category, amount: p.amount, note }, tx, ['penalty', 'money']);
    return { penalty: serialize(await tx.penalty.findUniqueOrThrow({ where: { id } })), duplicate: false };
  });
}

/** «Цалингаас хассан» (Нягтлан, Админ). Ажилтны цалин модуль `markDeducted`-ийг дуудна */
export async function setDeducted(actor: UserActor, idIn: unknown) {
  if (!canDeduct(actor.roles)) throw forbidden('Торгуулийг цалингаас хасах эрх нягтлан, админд');
  const id = Number(idIn);
  return db.$transaction(async (tx) => {
    const p = await tx.penalty.findUnique({ where: { id } });
    if (!p) throw notFound('Торгууль олдсонгүй');
    if (p.status !== 'ACTIVE') throw conflict('Цуцлагдсан торгууль', 'cancelled');
    if (p.deducted) return { penalty: serialize(p), duplicate: true };
    await markDeducted(tx, [id], actor);
    return { penalty: serialize(await tx.penalty.findUniqueOrThrow({ where: { id } })), duplicate: false };
  });
}
export async function markDeducted(tx: Tx, ids: number[], actor: Actor) {
  if (!ids.length) return 0;
  const n = await tx.penalty.updateMany({ where: { id: { in: ids }, status: 'ACTIVE', deducted: false }, data: { deducted: true, deductedAt: new Date(), deductedByName: actor.name, version: { increment: 1 } } });
  if (n.count) await writeAudit(actor, 'penalty.deducted', 'Penalty', ids.join(','), { count: n.count }, tx, ['penalty', 'money']);
  return n.count;
}

export interface PenaltyFilter { from?: string; to?: string; type?: string; userId?: string; status?: string; page?: number }
function where(f: PenaltyFilter, userId?: string): Prisma.PenaltyWhereInput {
  const w: Prisma.PenaltyWhereInput[] = [];
  if (userId) w.push({ userId });
  else if (f.userId && /^[0-9a-f-]{36}$/i.test(f.userId)) w.push({ userId: f.userId });
  if (f.from && isYmd(f.from)) w.push({ createdAt: { gte: ubDayStart(f.from) } });
  if (f.to && isYmd(f.to)) w.push({ createdAt: { lt: ubDayStart(addDays(f.to, 1)) } });
  if (f.type && TYPES.includes(f.type as PenaltyType)) w.push({ type: f.type as PenaltyType });
  if (f.status === 'PENDING') w.push({ status: 'ACTIVE', deducted: false });
  else if (f.status === 'DEDUCTED') w.push({ status: 'ACTIVE', deducted: true });
  else if (f.status === 'CANCELLED') w.push({ status: 'CANCELLED' });
  return w.length ? { AND: w } : {};
}

async function summarize(w: Prisma.PenaltyWhereInput) {
  const rows = await db.penalty.groupBy({ by: ['type', 'status', 'deducted'], where: w, _sum: { amount: true, deductedAmount: true }, _count: true });
  const byType = Object.fromEntries(TYPES.map((t) => [t, { count: 0, amount: 0 }])) as Record<PenaltyType, { count: number; amount: number }>;
  let total = 0, count = 0, pending = 0, deducted = 0, cancelled = 0;
  for (const r of rows) {
    const a = r._sum.amount ?? 0;
    if (r.status === 'CANCELLED') { cancelled += r._count; continue; }
    byType[r.type].count += r._count; byType[r.type].amount += a; total += a; count += r._count;
    // Цалингаас хассан (хэсэгчилсэн ч) — Модуль 7б
    const d = r.deducted ? a : Math.min(a, r._sum.deductedAmount ?? 0);
    deducted += d; pending += a - d;
  }
  return { total, count, pending, deducted, cancelled, byType };
}

export async function listPenalties(actor: UserActor, f: PenaltyFilter) {
  if (!canView(actor.roles, 'penalties')) throw forbidden();
  const page = Math.max(1, Math.floor(Number(f.page) || 1));
  const w = where(f);
  const [items, total, summary, staff] = await Promise.all([
    db.penalty.findMany({ where: w, orderBy: { createdAt: 'desc' }, skip: (page - 1) * 50, take: 50 }),
    db.penalty.count({ where: w }),
    summarize(where({ ...f, status: undefined })),
    db.user.findMany({ where: { isActive: true, roles: { hasSome: ['OPERATOR', 'OPERATOR_LEAD', 'DRIVER', 'DRIVER_LEAD', 'MARKETING', 'MARKETING_LEAD', 'WAREHOUSE', 'ACCOUNTING', 'ADMIN'] } }, select: { id: true, name: true, phone: true, roles: true }, orderBy: { name: 'asc' } }),
  ]);
  return {
    page, total, pages: Math.max(1, Math.ceil(total / 50)), summary,
    canManage: canManage(actor.roles), canDeduct: canDeduct(actor.roles),
    items: items.map(serialize),
    staff: staff.map((s) => ({ ...s, defaultType: typeForRoles(s.roles) })),
  };
}

/** «Ажилчдын мэдээлэл»: нэг ажилтны торгууль + буцаагаагүй барааны зээл */
export async function employeeInfo(actor: UserActor, userIdIn: unknown) {
  if (!canView(actor.roles, 'penalties')) throw forbidden();
  const userId = String(userIdIn ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw badRequest('Ажилтнаа сонгоно уу');
  const u = await db.user.findUnique({ where: { id: userId }, select: { id: true, name: true, phone: true, roles: true } });
  if (!u) throw notFound('Ажилтан олдсонгүй');
  const [summary, recent, loans] = await Promise.all([
    summarize({ userId }),
    db.penalty.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 50 }),
    db.staffLoan.findMany({ where: { staffId: userId, status: 'ISSUED' }, include: { lines: true }, orderBy: { issuedAt: 'desc' }, take: 50 }),
  ]);
  const loanRows = loans.map((l) => {
    const open = l.lines.map((x) => ({ qty: x.qty - x.returnedQty - x.chargedQty, price: x.deduction ?? x.unitPrice ?? 0 })).filter((x) => x.qty > 0);
    return { id: l.id, issuedAt: l.issuedAt, pieces: open.reduce((s, x) => s + x.qty, 0), amount: open.reduce((s, x) => s + x.qty * x.price, 0), note: l.note };
  }).filter((l) => l.pieces > 0);
  return { user: u, summary, recent: recent.map(serialize), loans: loanRows, loanTotal: loanRows.reduce((s, l) => s + l.amount, 0) };
}

/** «Миний торгууль» — зөвхөн өөрийнх */
export async function myPenalties(actor: UserActor, f: PenaltyFilter) {
  if (!canView(actor.roles, 'my-penalties')) throw forbidden();
  const page = Math.max(1, Math.floor(Number(f.page) || 1));
  const w = where(f, actor.id);
  const [items, total, summary] = await Promise.all([
    db.penalty.findMany({ where: w, orderBy: { createdAt: 'desc' }, skip: (page - 1) * 50, take: 50 }),
    db.penalty.count({ where: w }),
    summarize(where({ ...f, status: undefined }, actor.id)),
  ]);
  return { page, total, pages: Math.max(1, Math.ceil(total / 50)), summary, items: items.map(serialize), today: ubDay() };
}

// ───────────────────────── Автомат торгууль (асуудлаас, хуучин шиг) ─────────────────────────

/**
 * resolveIssue «Цуцлах»-ын transaction дотор дуудна. Буцаах: анхааруулга (хариуцагч олдоогүй) эсвэл null.
 * Нэг захиалгад нэг төрөл нэг л удаа (database-ийн хамгаалалт).
 */
export async function autoPenaltyForIssue(tx: Tx, actor: Actor, o: { id: number; number: string; operatorId: string; handoverId: number | null; issueType: string | null }, fault: 'OPERATOR' | 'DRIVER' | 'MARKETING' | 'WAREHOUSE'): Promise<string | null> {
  if (fault === 'DRIVER') return null;
  const type: PenaltyType = fault === 'OPERATOR' ? 'OPP_ERROR' : fault === 'MARKETING' ? 'MARKETING_ERROR' : 'WAREHOUSE_ERROR';
  let user: { id: string; name: string; roles: Role[] } | null = null;
  if (fault === 'OPERATOR') user = await tx.user.findUnique({ where: { id: o.operatorId }, select: { id: true, name: true, roles: true } });
  else if (fault === 'MARKETING') {
    const u = await tx.user.findUnique({ where: { id: o.operatorId }, select: { id: true, name: true, roles: true } });
    if (u && u.roles.some((r) => r === 'MARKETING' || r === 'MARKETING_LEAD')) user = u;
  } else if (o.handoverId) {
    const h = await tx.handover.findUnique({ where: { id: o.handoverId }, select: { preparedById: true, preparedBy: true } });
    if (h?.preparedById) user = await tx.user.findUnique({ where: { id: h.preparedById }, select: { id: true, name: true, roles: true } });
    else if (h?.preparedBy) {
      const c = await tx.user.findMany({ where: { name: h.preparedBy, roles: { has: 'WAREHOUSE' } }, select: { id: true, name: true, roles: true }, take: 2 });
      if (c.length === 1) user = c[0]!;
    }
  }
  if (!user) return `${PENALTY_TYPE_LABEL[type]}: хариуцагч олдсонгүй — торгууль үүссэнгүй (Алдаа удирдлагаас гараар тавина)`;
  const exists = await tx.penalty.findFirst({ where: { orderId: o.id, type, auto: true, status: 'ACTIVE' }, select: { id: true } });
  if (exists) return null;
  const cfg = await readPenaltyConfig(tx);
  const amount = cfg.autoAmount[type as keyof PenaltyConfig['autoAmount']];
  const what = ISSUE_TEXT[o.issueType ?? ''] ?? 'Асуудал';
  const p = await tx.penalty.create({ data: {
    type, category: `${what}${fault === 'WAREHOUSE' ? ' (Агуулах)' : ''}`, amount, description: `${what} — Захиалга №${o.number}`, userId: user.id, userName: user.name,
    orderId: o.id, orderNumber: o.number, auto: true, createdById: actor.id, createdByName: actor.name,
  } });
  await writeAudit(actor, 'penalty.auto_created', 'Penalty', String(p.id), { user: user.name, type, amount, order: o.number }, tx, ['penalty', 'money']);
  return null;
}
