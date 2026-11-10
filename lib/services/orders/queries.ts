import { Prisma, type OrderStatus } from '@prisma/client';
import { db } from '../../db';
import { badRequest, forbidden, notFound } from '../../errors';
import { canEditOrders, canMarkPaid, canReviewDiscounts, canSuperviseOperators, canView } from '../../permissions';
import { fullAddress, PROVINCES, UB_DISTRICTS } from '../../geo';
import { mediaUrl } from '../../storage';
import { normalizePhone, isValidPhone } from '../../phone';
import { ubDay, ubDayStart, dateOnly, ymdOf, isYmd } from '../../ubdate';
import { CANCEL_LABEL, STATUS_LABEL, displayStatus, type UserActor } from './core';

export const ORDER_PAGE_SIZE = 50;
const assertView = (a: UserActor) => { if (!canView(a.roles, 'orders')) throw forbidden(); };

type OrderWithLines = Prisma.OrderGetPayload<{ include: { lines: true } }>;

export function serializeOrder(o: OrderWithLines, pageName?: string | null) {
  const tomorrow = ubDay(new Date(), 1);
  const ds = displayStatus(o, tomorrow);
  return {
    id: o.id, number: o.number, status: o.status, displayStatus: ds, statusLabel: STATUS_LABEL[ds],
    phone: o.phone, extraPhone: o.extraPhone, province: o.province, district: o.district, khoroo: o.khoroo, addressDetail: o.addressDetail,
    fullAddress: fullAddress(o), noKhoroo: !!o.district && !o.khoroo,
    note: o.note, pageId: o.pageId, pageName: pageName ?? null, operatorId: o.operatorId, operatorName: o.operatorName,
    deliveryDate: ymdOf(o.deliveryDate), isToday: ymdOf(o.deliveryDate) === ubDay(), prepaid: o.prepaid,
    confirmedAt: o.confirmedAt, paymentDeadline: o.paymentDeadline, createdAt: o.createdAt,
    subtotal: o.subtotal, discount: o.discount, deliveryFee: o.deliveryFee, total: o.total, deliveryFeeEdited: o.deliveryFeeEdited,
    blacklistNote: o.blacklistNote, postponeCount: o.postponeCount, inHandover: !!o.handoverId,
    cancelReason: o.cancelReason, cancelLabel: o.cancelReason ? CANCEL_LABEL[o.cancelReason] : null, cancelNote: o.cancelNote, cancelledAt: o.cancelledAt, cancelledByName: o.cancelledByName,
    version: o.version,
    lines: o.lines.map((l) => ({
      id: l.id, variantId: l.variantId, productId: l.productId, code: l.code, name: l.name, label: l.label,
      thumb: l.imageKey ? mediaUrl(l.imageKey, 'sm') : null, image: l.imageKey ? mediaUrl(l.imageKey, 'lg') : null,
      listPrice: l.listPrice, unitPrice: l.unitPrice, qty: l.qty, discountReason: l.discountReason, deliveryIncluded: l.deliveryIncluded,
    })),
  };
}

async function pageNames(ids: number[]) {
  if (!ids.length) return new Map<number, string>();
  return new Map((await db.page.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true } })).map((p) => [p.id, p.name]));
}

export type Tab = 'today' | 'PENDING_PAYMENT' | 'SCHEDULED' | 'NEW' | 'ASSIGNED' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'CANCELLED' | 'all';
export interface ListParams {
  tab?: string; q?: string; from?: string; to?: string; operatorId?: string; pageId?: number; province?: string; district?: string;
  prepaid?: boolean; noKhoroo?: boolean; postponed?: boolean; todayDelivery?: boolean; page?: number;
  /** Хуучин ERP шиг «Төлөв» олон сонголт (таслалаар): PENDING_PAYMENT, NEW, SCHEDULED, ASSIGNED, OUT_FOR_DELIVERY, DELIVERED, CANCELLED */
  statuses?: string;
}

/** Хайлт (#43): утас (хэсэг), дугаар, хаяг, тэмдэглэл, барааны нэр/код — trigram индексээр, 1 сая захиалгад хурдан */
async function searchIds(q: string): Promise<number[] | null> {
  const s = q.trim();
  if (!s) return null;
  const digits = s.replace(/[\s-]/g, '');
  const like = `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  if (/^\d{3,8}$/.test(digits)) {
    const dl = `%${digits}%`;
    const rows = await db.$queryRaw<{ id: number }[]>`
      (SELECT id FROM "Order" WHERE number = ${digits.padStart(8, '0')} LIMIT 5)
      UNION (SELECT id FROM "Order" WHERE phone LIKE ${dl} ORDER BY id DESC LIMIT 500)
      UNION (SELECT id FROM "Order" WHERE "extraPhone" LIKE ${dl} ORDER BY id DESC LIMIT 200)
      UNION (SELECT "orderId" FROM "OrderLine" WHERE code ILIKE ${dl} ORDER BY "orderId" DESC LIMIT 300)`;
    return rows.map((r) => r.id);
  }
  if (s.length < 2) return [];
  // Түгээмэл үг (40k+ таарц) бол PK-аар буцаж уншина, ховор үг бол trigram индекс — үг бүрт тохирох төлөвлөгөө сонгуулна
  const [, rows] = await db.$transaction([db.$executeRaw`SET LOCAL plan_cache_mode = force_custom_plan`, db.$queryRaw<{ id: number }[]>`
    (SELECT id FROM "Order" WHERE "addressDetail" ILIKE ${like} ORDER BY id DESC LIMIT 500)
    UNION (SELECT id FROM "Order" WHERE note ILIKE ${like} ORDER BY id DESC LIMIT 200)
    UNION (SELECT "orderId" FROM "OrderLine" WHERE name ILIKE ${like} OR code ILIKE ${like} ORDER BY "orderId" DESC LIMIT 500)
  `]);
  // Дүүрэг/аймаг цөөн тогтмол утгатай — индексгүй ILIKE (бүтэн уншилт) биш, жагсаалтаас тааруулж тэнцүүгээр хайна
  const low = s.toLowerCase();
  const dists = Object.keys(UB_DISTRICTS).filter((d) => d.toLowerCase().includes(low));
  const provs = PROVINCES.filter((x) => x.toLowerCase().includes(low));
  const geo = dists.length || provs.length ? await db.$queryRaw<{ id: number }[]>`
    SELECT id FROM "Order" WHERE district = ANY(${dists}::text[]) OR province = ANY(${provs}::text[]) ORDER BY id DESC LIMIT 200` : [];
  return [...new Set([...rows, ...geo].map((r) => r.id))];
}

export async function listOrders(actor: UserActor, p: ListParams) {
  assertView(actor);
  const today = ubDay();
  const tomorrow = ubDay(new Date(), 1);
  const and: Prisma.OrderWhereInput[] = [];
  const tab = (p.statuses !== undefined ? 'all' : p.tab ?? (p.q ? 'all' : 'today')) as Tab;
  if (p.statuses) {
    const or: Prisma.OrderWhereInput[] = [];
    for (const st of [...new Set(p.statuses.split(',').map((x) => x.trim()).filter(Boolean))]) {
      if (st === 'SCHEDULED') or.push({ status: 'NEW', deliveryDate: { gt: dateOnly(tomorrow) } });
      else if (st === 'NEW') or.push({ status: 'NEW', deliveryDate: { lte: dateOnly(tomorrow) } });
      else if (['PENDING_PAYMENT', 'ASSIGNED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED'].includes(st)) or.push({ status: st as OrderStatus });
      else throw badRequest('Төлөв буруу');
    }
    if (or.length) and.push({ OR: or });
  }
  switch (tab) {
    case 'today': and.push({ createdAt: { gte: ubDayStart(today) } }); break;
    case 'SCHEDULED': and.push({ status: 'NEW', deliveryDate: { gt: dateOnly(tomorrow) } }); break;
    case 'NEW': and.push({ status: 'NEW', deliveryDate: { lte: dateOnly(tomorrow) } }); break;
    case 'all': break;
    default:
      if (!['PENDING_PAYMENT', 'ASSIGNED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED'].includes(tab)) throw badRequest('Таб буруу');
      and.push({ status: tab as OrderStatus });
  }
  if (p.from) { if (!isYmd(p.from)) throw badRequest('Огноо буруу'); and.push({ createdAt: { gte: ubDayStart(p.from) } }); }
  if (p.to) { if (!isYmd(p.to)) throw badRequest('Огноо буруу'); and.push({ createdAt: { lt: new Date(ubDayStart(p.to).getTime() + 86_400_000) } }); }
  if (p.operatorId) { if (!/^[0-9a-f-]{36}$/i.test(p.operatorId)) throw badRequest('Оператор буруу'); and.push({ operatorId: p.operatorId }); }
  if (p.pageId) and.push({ pageId: p.pageId });
  if (p.province) and.push({ province: p.province });
  if (p.district) and.push({ district: p.district });
  if (p.prepaid) and.push({ prepaid: true });
  if (p.noKhoroo) and.push({ district: { not: null }, khoroo: null });
  if (p.postponed) and.push({ postponeCount: { gt: 0 } });
  if (p.todayDelivery) and.push({ deliveryDate: dateOnly(today), status: { in: ['NEW', 'ASSIGNED'] } });
  const ids = p.q ? await searchIds(p.q) : null;
  if (ids) and.push({ id: { in: ids.length ? ids : [-1] } });
  const where: Prisma.OrderWhereInput = and.length ? { AND: and } : {};
  const page = Math.max(1, Math.min(2000, Math.floor(p.page ?? 1)));
  // Огноогоор шүүсэн бол (createdAt) индексээр, бусад үед дугаараар — хоёулаа «шинэ нь эхэндээ»
  const orderBy: Prisma.OrderOrderByWithRelationInput[] = p.from || p.to ? [{ createdAt: 'desc' }, { id: 'desc' }] : [{ id: 'desc' }];
  const rows = await db.order.findMany({ where, orderBy, skip: (page - 1) * ORDER_PAGE_SIZE, take: ORDER_PAGE_SIZE + 1, include: { lines: true } });
  const hasMore = rows.length > ORDER_PAGE_SIZE;
  const list = rows.slice(0, ORDER_PAGE_SIZE);
  const [pn, matched] = await Promise.all([
    pageNames(list.map((o) => o.pageId)),
    // «Үр дүн: N» (хуучин шиг) — 10,000-аас олон бол «10,000+» (1 сая мөрийг тоолж удаашруулахгүй)
    and.length ? db.order.count({ where, take: RESULT_CAP + 1 }) : Promise.resolve(null),
  ]);
  return {
    tab, page, pageSize: ORDER_PAGE_SIZE, hasMore, matched, matchedCapped: matched !== null && matched > RESULT_CAP,
    counts: await tabCounts(),
    can: { edit: canEditOrders(actor.roles), markPaid: canMarkPaid(actor.roles), supervise: canSuperviseOperators(actor.roles), review: canReviewDiscounts(actor.roles) },
    items: list.map((o) => serializeOrder(o, pn.get(o.pageId))),
  };
}

const RESULT_CAP = 10_000;
let countsCache: { at: number; data: Record<string, number> } | null = null;
/** Таб бүрийн тоо (идэвхтэй төлвүүд + өнөөдөр) — индексээр, 5 сек санана */
export async function tabCounts(): Promise<Record<string, number>> {
  if (countsCache && Date.now() - countsCache.at < 5000) return countsCache.data;
  const today = ubDay(); const tomorrow = ubDay(new Date(), 1);
  const rows = await db.$queryRaw<{ k: string; n: number }[]>`
    SELECT 'today' AS k, count(*)::int AS n FROM "Order" WHERE "createdAt" >= ${ubDayStart(today)}
    UNION ALL SELECT 'PENDING_PAYMENT', count(*)::int FROM "Order" WHERE status = 'PENDING_PAYMENT'
    UNION ALL SELECT 'NEW', count(*)::int FROM "Order" WHERE status = 'NEW' AND "deliveryDate" <= ${dateOnly(tomorrow)}
    UNION ALL SELECT 'SCHEDULED', count(*)::int FROM "Order" WHERE status = 'NEW' AND "deliveryDate" > ${dateOnly(tomorrow)}
    UNION ALL SELECT 'ASSIGNED', count(*)::int FROM "Order" WHERE status = 'ASSIGNED'
    UNION ALL SELECT 'OUT_FOR_DELIVERY', count(*)::int FROM "Order" WHERE status = 'OUT_FOR_DELIVERY'
    UNION ALL SELECT 'postponed', count(*)::int FROM "Order" WHERE "postponeCount" > 0 AND status IN ('NEW','ASSIGNED')
    UNION ALL SELECT 'todayDelivery', count(*)::int FROM "Order" WHERE status IN ('NEW','ASSIGNED') AND "deliveryDate" = ${dateOnly(today)}`;
  const data = Object.fromEntries(rows.map((r) => [r.k, r.n]));
  countsCache = { at: Date.now(), data };
  return data;
}
export const bustCounts = () => { countsCache = null; };

export async function getOrder(actor: UserActor, idInput: unknown) {
  assertView(actor);
  const id = Number(idInput);
  if (!Number.isInteger(id) || id <= 0) throw notFound('Захиалга олдсонгүй');
  const o = await db.order.findUnique({ where: { id }, include: { lines: true } });
  if (!o) throw notFound('Захиалга олдсонгүй');
  const [pn, history, meta] = await Promise.all([
    pageNames([o.pageId]),
    db.auditLog.findMany({ where: { entityType: 'Order', entityId: String(id) }, orderBy: { id: 'asc' }, take: 200 }),
    db.metaEvent.findUnique({ where: { orderId: id } }),
  ]);
  return {
    ...serializeOrder(o, pn.get(o.pageId)),
    history: history.map((h) => ({ id: h.id.toString(), at: h.at, actorName: h.actorName, action: h.action, details: h.details, tags: h.tags })),
    meta: meta ? { status: meta.status, sentAt: meta.sentAt, attempts: meta.attempts } : null,
    can: { edit: canEditOrders(actor.roles), markPaid: canMarkPaid(actor.roles) },
  };
}

/** Үйлчлүүлэгчийн карт (#51): утас бичмэгц — өмнөх захиалга, хар жагсаалт, идэвхтэй захиалга, дуудлага, сүүлийн хаяг */
export async function customerCard(actor: UserActor, phonesInput: string[]) {
  assertView(actor);
  const phones = [...new Set(phonesInput.map((p) => normalizePhone(p)).filter(isValidPhone))].slice(0, 2);
  if (!phones.length) return { phones, orders: [], stats: { total: 0, delivered: 0, cancelled: 0 }, active: null, blacklist: [], calls: [], lastAddress: null };
  const byPhone: Prisma.OrderWhereInput = { OR: [{ phone: { in: phones } }, { extraPhone: { in: phones } }] };
  const [orders, stats, blacklist, calls] = await Promise.all([
    db.order.findMany({ where: byPhone, orderBy: { id: 'desc' }, take: 6, include: { lines: true } }),
    db.order.groupBy({ by: ['status'], where: byPhone, _count: true }),
    db.blacklistEntry.findMany({ where: { phone: { in: phones }, isActive: true }, orderBy: { id: 'desc' }, take: 5 }),
    db.callNote.findMany({ where: { phone: { in: phones }, status: { in: ['PENDING', 'CONTACTED'] } }, orderBy: { id: 'desc' }, take: 5 }),
  ]);
  const pn = await pageNames([...orders.map((o) => o.pageId), ...calls.map((c) => c.pageId).filter((x): x is number => !!x)]);
  const ser = orders.map((o) => serializeOrder(o, pn.get(o.pageId)));
  const active = ser.find((o) => ['PENDING_PAYMENT', 'NEW', 'ASSIGNED'].includes(o.status)) ?? null;
  const last = orders[0];
  const callVariants = calls.map((c) => c.variantId).filter((x): x is number => !!x);
  const variants = callVariants.length ? await db.productVariant.findMany({ where: { id: { in: callVariants } }, select: { id: true, code: true, product: { select: { name: true } } } }) : [];
  const vn = new Map(variants.map((v) => [v.id, `${v.product.name} (${v.code})`]));
  const count = (s: OrderStatus) => stats.find((x) => x.status === s)?._count ?? 0;
  return {
    phones,
    orders: ser.map((o) => ({ id: o.id, number: o.number, displayStatus: o.displayStatus, statusLabel: o.statusLabel, createdAt: o.createdAt, total: o.total, lines: o.lines.map((l) => `${l.name}${l.label ? ` · ${l.label}` : ''} ${l.qty}ш`) })),
    stats: { total: stats.reduce((a, s) => a + s._count, 0), delivered: count('DELIVERED'), cancelled: count('CANCELLED') },
    active: active ? { id: active.id, number: active.number, statusLabel: active.statusLabel, deliveryDate: active.deliveryDate, inHandover: active.inHandover, version: active.version, operatorName: active.operatorName, lines: active.lines } : null,
    blacklist: blacklist.map((b) => ({ id: b.id, phone: b.phone, reason: b.reason, reportedBy: b.reportedBy, createdAt: b.createdAt, orderNumber: b.orderNumber })),
    calls: calls.map((c) => ({ id: c.id, phone: c.phone, note: c.note, product: c.variantId ? vn.get(c.variantId) ?? null : c.productText, variantId: c.variantId, pageId: c.pageId, pageName: c.pageId ? pn.get(c.pageId) ?? null : null, ownerName: c.ownerName, attempts: c.attempts, createdAt: c.createdAt })),
    lastAddress: last ? { province: last.province, district: last.district, khoroo: last.khoroo, addressDetail: last.addressDetail, fullAddress: fullAddress(last) } : null,
  };
}

/** Цагийн мэдээ (#52): бүх операторт — өнөөдөр 11, 13, 15, 18, 21 цаг хүртэл хэдэн баталгаажсан захиалга */
/**
 * Цагийн мэдээ — хуучин ERP-ийн логикоор (эзний шаардлага 2026-11-11):
 * тухайн өдөр ҮҮССЭН, «Цуцлагдсан» ба «Төлбөр хүлээж буй»-гаас бусад захиалга, ҮҮССЭН цагаар;
 * 11, 13, 15, 18, 21 цаг хүртэлх нийлбэр; 21 цагаас хойш үүссэн нь «21:00»-д нэмэгдэнэ.
 */
export async function hourlyReport(actor: UserActor, dateInput?: string) {
  assertView(actor);
  const date = dateInput && isYmd(dateInput) ? dateInput : ubDay();
  const start = ubDayStart(date);
  const end = new Date(start.getTime() + 86_400_000);
  const rows = await db.$queryRaw<{ operatorId: string; operatorName: string; h: number; n: number }[]>`
    SELECT "operatorId", max("operatorName") AS "operatorName", extract(hour FROM "createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Ulaanbaatar')::int AS h, count(*)::int AS n
    FROM "Order" WHERE "createdAt" >= ${start} AND "createdAt" < ${end} AND status NOT IN ('CANCELLED', 'PENDING_PAYMENT')
    GROUP BY "operatorId", h`;
  const CUTS = [11, 13, 15, 18, 21];
  const by = new Map<string, { operatorId: string; name: string; per: number[]; total: number }>();
  for (const r of rows) {
    const e = by.get(r.operatorId) ?? { operatorId: r.operatorId, name: r.operatorName, per: CUTS.map(() => 0), total: 0 };
    let idx = CUTS.findIndex((c) => r.h < c);
    if (idx < 0) idx = CUTS.length - 1; // 21 цагаас хойш → «21:00»
    e.per[idx]! += r.n;
    e.total += r.n;
    by.set(r.operatorId, e);
  }
  const list = [...by.values()].map((e) => { let run = 0; return { ...e, cum: e.per.map((n) => (run += n)) }; }).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  return { date, cuts: CUTS, rows: list.map((e, i) => ({ rank: i + 1, operatorId: e.operatorId, name: e.name, cum: e.cum, total: e.total, me: e.operatorId === actor.id })), total: list.reduce((a, e) => a + e.total, 0) };
}

/** Пэйжийн түгээмэл бараа (#50, туршилт): сүүлийн 7 хоногийн баталгаажсан захиалгаар хамгийн их зарагдсан 8 хувилбар */
export async function popularForPage(actor: UserActor, pageId: number) {
  assertView(actor);
  if (!Number.isInteger(pageId) || pageId <= 0) return [];
  const since = new Date(Date.now() - 7 * 86_400_000);
  const rows = await db.$queryRaw<{ variantId: number; qty: number }[]>`
    SELECT l."variantId", sum(l.qty)::int AS qty FROM "OrderLine" l JOIN "Order" o ON o.id = l."orderId"
    WHERE o."pageId" = ${pageId} AND o."confirmedAt" >= ${since} AND o.status <> 'CANCELLED'
    GROUP BY l."variantId" ORDER BY qty DESC LIMIT 8`;
  return rows;
}

// ───────────────────────── хөнгөлөлтийн хяналт (Супер админ, #43 2) ─────────────────────────

export async function discountReviewList(actor: UserActor, p: { unreviewed?: boolean; page?: number }) {
  if (!canReviewDiscounts(actor.roles)) throw forbidden('Зөвхөн Супер админ');
  const page = Math.max(1, Math.floor(p.page ?? 1));
  const where: Prisma.AuditLogWhereInput = { entityType: 'Order', tags: { has: 'discount' } };
  const rows = await db.$queryRaw<{ id: bigint }[]>`
    SELECT a.id FROM "AuditLog" a WHERE a."entityType" = 'Order' AND 'discount' = ANY(a.tags)
    ${p.unreviewed ? Prisma.sql`AND NOT EXISTS (SELECT 1 FROM "AuditReview" r WHERE r."auditLogId" = a.id)` : Prisma.empty}
    ORDER BY a.id DESC LIMIT 31 OFFSET ${(page - 1) * 30}`;
  const logs = await db.auditLog.findMany({ where: { ...where, id: { in: rows.map((r) => r.id) } }, orderBy: { id: 'desc' } });
  const reviews = await db.auditReview.findMany({ where: { auditLogId: { in: logs.map((l) => l.id) } } });
  const rv = new Map(reviews.map((r) => [r.auditLogId.toString(), r]));
  return {
    page, hasMore: rows.length > 30, unreviewed: await unreviewedDiscounts(),
    items: logs.slice(0, 30).map((l) => ({ id: l.id.toString(), at: l.at, actorName: l.actorName, action: l.action, orderId: Number(l.entityId), details: l.details, review: rv.get(l.id.toString()) ? { by: rv.get(l.id.toString())!.reviewedByName, at: rv.get(l.id.toString())!.reviewedAt } : null })),
  };
}

export async function unreviewedDiscounts(): Promise<number> {
  const r = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM "AuditLog" a WHERE a."entityType" = 'Order' AND 'discount' = ANY(a.tags)
    AND NOT EXISTS (SELECT 1 FROM "AuditReview" r WHERE r."auditLogId" = a.id)`;
  return r[0]?.n ?? 0;
}

export async function reviewDiscounts(actor: UserActor, ids: unknown) {
  if (!canReviewDiscounts(actor.roles)) throw forbidden('Зөвхөн Супер админ');
  let target: bigint[];
  if (ids === 'all') {
    target = (await db.$queryRaw<{ id: bigint }[]>`
      SELECT a.id FROM "AuditLog" a WHERE a."entityType" = 'Order' AND 'discount' = ANY(a.tags)
      AND NOT EXISTS (SELECT 1 FROM "AuditReview" r WHERE r."auditLogId" = a.id) LIMIT 5000`).map((r) => r.id);
  } else if (Array.isArray(ids) && ids.length && ids.length <= 500) {
    target = ids.map((x) => { if (!/^\d+$/.test(String(x))) throw badRequest('Мөр буруу'); return BigInt(String(x)); });
    const ok = await db.auditLog.count({ where: { id: { in: target }, entityType: 'Order', tags: { has: 'discount' } } });
    if (ok !== target.length) throw badRequest('Мөр буруу');
  } else throw badRequest('Мөр сонгоно уу');
  const r = await db.auditReview.createMany({ data: target.map((id) => ({ auditLogId: id, reviewedById: actor.id, reviewedByName: actor.name })), skipDuplicates: true });
  return { reviewed: r.count };
}
