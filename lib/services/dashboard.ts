import { Prisma } from '@prisma/client';
import { db } from '../db';
import { badRequest, forbidden } from '../errors';
import { canEdit, canReviewDiscounts, canView } from '../permissions';
import { dateOnly, isYmd, ubDay, ubDayStart, ymdOf } from '../ubdate';
import { addDays } from './delivery/core';
import { CANCEL_LABEL } from './orders/core';
import { unreviewedDiscounts } from './orders/queries';
import { alertBanner, pageShortView, reorderBanner } from './outflow';
import { reconcileAlert } from './stock/views';
import { pendingIssueCount } from './delivery/driver';
import { unreviewedCount } from './product-history';
import type { UserActor } from './users';

/**
 * Модуль 7 — Хянах самбар (хуучин «Хянах самбар»-ын логикоор + засвар, #123):
 *  • өдөр = ЗАХИАЛГЫН өдөр (баталгаажсан, Улаанбаатар; урьдчилж төлсөн — мөнгө орсон өдөр, #102), төлбөр хүлээж буй орохгүй;
 *  • Нийт = бүх бодит захиалга (цуцлагдсан орно) — хуучинд цуцлагдсаныг хасаад хувь буруу гардаг байсан;
 *  • Цуцлагдсан = цуцлагдсан + жолооч хойшлуулаад дахин хуваарилагдаагүй (хуучин шиг); хүргэгдвэл Хүргэсэн;
 *  • Амжилт % = хүргэсэн ÷ нийт, Цуцлалт % = цуцлагдсан ÷ нийт; чиг хандлага картуудтай яг ижил өдрөөр (хуучны UTC зөрүү засагдсан).
 * Зөвхөн уншина. 60 сек кэш.
 */
const RANGE: Record<string, number> = { day: 1, week: 7, month: 30 };
const POSTPONED = Prisma.sql`(o.status = 'NEW' AND o."postponedByDriverId" IS NOT NULL)`;
const REAL = Prisma.sql`o.status <> 'PENDING_PAYMENT' AND o."confirmedAt" IS NOT NULL`;

const cache = new Map<string, { at: number; v: unknown }>();
async function cached<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const c = cache.get(key);
  if (c && Date.now() - c.at < ttl) return c.v as T;
  const v = await fn();
  cache.set(key, { at: Date.now(), v });
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return v;
}
export function bustDashboard() { cache.clear(); }

const assertView = (a: UserActor) => { if (!canView(a.roles, 'dashboard')) throw forbidden(); };
const rate = (n: number, total: number) => (total ? Math.round((n / total) * 1000) / 10 : 0);

export async function summary(actor: UserActor, rangeIn: unknown, dateIn: unknown) {
  assertView(actor);
  const range = typeof rangeIn === 'string' && RANGE[rangeIn] ? rangeIn : 'day';
  const to = dateIn === undefined || dateIn === null || dateIn === '' ? ubDay() : String(dateIn);
  if (!isYmd(to)) throw badRequest('Огноо буруу');
  const n = RANGE[range]!;
  const from = addDays(to, -(n - 1));
  return cached(`s:${range}:${to}`, range === 'day' ? 60_000 : 300_000, async () => {
    const [days, reasons, products, hours, sold, pages] = await Promise.all([
      db.$queryRaw<{ day: Date; total: number; delivered: number; cancelled: number; inDelivery: number; waiting: number; postponed: number }[]>`
        SELECT (o."confirmedAt" + interval '8 hours')::date AS day, count(*)::int AS total,
          count(*) FILTER (WHERE o.status = 'DELIVERED')::int AS delivered,
          count(*) FILTER (WHERE o.status = 'CANCELLED' OR ${POSTPONED})::int AS cancelled,
          count(*) FILTER (WHERE o.status = 'OUT_FOR_DELIVERY')::int AS "inDelivery",
          count(*) FILTER (WHERE o.status IN ('NEW', 'ASSIGNED') AND NOT ${POSTPONED})::int AS waiting,
          count(*) FILTER (WHERE ${POSTPONED})::int AS postponed
        FROM "Order" o WHERE ${REAL} AND o."confirmedAt" >= ${ubDayStart(from)} AND o."confirmedAt" < ${ubDayStart(addDays(to, 1))}
        GROUP BY 1`,
      db.$queryRaw<{ reason: string | null; n: number }[]>`
        SELECT CASE WHEN ${POSTPONED} THEN 'POSTPONED' ELSE o."cancelReason"::text END AS reason, count(*)::int AS n
        FROM "Order" o WHERE ${REAL} AND o."confirmedAt" >= ${ubDayStart(from)} AND o."confirmedAt" < ${ubDayStart(addDays(to, 1))}
          AND (o.status = 'CANCELLED' OR ${POSTPONED})
        GROUP BY 1 ORDER BY 2 DESC`,
      db.$queryRaw<{ productId: number; code: string; name: string; orders: number; qty: number }[]>`
        SELECT l."productId", p.code, p.name, count(DISTINCT o.id)::int AS orders, sum(l.qty)::int AS qty
        FROM "Order" o JOIN "OrderLine" l ON l."orderId" = o.id JOIN "Product" p ON p.id = l."productId"
        WHERE ${REAL} AND o."confirmedAt" >= ${ubDayStart(from)} AND o."confirmedAt" < ${ubDayStart(addDays(to, 1))}
          AND (o.status = 'CANCELLED' OR ${POSTPONED})
        GROUP BY 1, 2, 3 ORDER BY 4 DESC, 5 DESC LIMIT 10`,
      // Аудит #162 (эзэн): захиалга орж ирсэн цаг (Улаанбаатар, баталгаажсан мөчөөр)
      db.$queryRaw<{ h: number; n: number }[]>`
        SELECT extract(hour from o."confirmedAt" + interval '8 hours')::int AS h, count(*)::int AS n
        FROM "Order" o WHERE ${REAL} AND o."confirmedAt" >= ${ubDayStart(from)} AND o."confirmedAt" < ${ubDayStart(addDays(to, 1))}
        GROUP BY 1`,
      // Хамгийн их зарагдсан бараа (цуцлагдаагүй захиалга)
      db.$queryRaw<{ productId: number; code: string; name: string; orders: number; qty: number }[]>`
        SELECT l."productId", p.code, p.name, count(DISTINCT o.id)::int AS orders, sum(l.qty)::int AS qty
        FROM "Order" o JOIN "OrderLine" l ON l."orderId" = o.id JOIN "Product" p ON p.id = l."productId"
        WHERE ${REAL} AND o."confirmedAt" >= ${ubDayStart(from)} AND o."confirmedAt" < ${ubDayStart(addDays(to, 1))} AND o.status <> 'CANCELLED'
        GROUP BY 1, 2, 3 ORDER BY 4 DESC, 5 DESC LIMIT 10`,
      // Пэйж бүрийн захиалга ба хүргэлт
      db.$queryRaw<{ pageId: number; name: string; total: number; delivered: number; cancelled: number }[]>`
        SELECT o."pageId", pg.name, count(*)::int AS total, count(*) FILTER (WHERE o.status = 'DELIVERED')::int AS delivered,
          count(*) FILTER (WHERE o.status = 'CANCELLED')::int AS cancelled
        FROM "Order" o JOIN "Page" pg ON pg.id = o."pageId"
        WHERE ${REAL} AND o."confirmedAt" >= ${ubDayStart(from)} AND o."confirmedAt" < ${ubDayStart(addDays(to, 1))}
        GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 12`,
    ]);
    const hm = new Map(hours.map((x) => [x.h, x.n]));
    const byDay = new Map(days.map((d) => [ymdOf(d.day), d]));
    const trend = Array.from({ length: n }, (_, i) => addDays(from, i)).map((d) => {
      const r = byDay.get(d);
      return { date: d, total: r?.total ?? 0, delivered: r?.delivered ?? 0, cancelled: r?.cancelled ?? 0, inDelivery: r?.inDelivery ?? 0, waiting: r?.waiting ?? 0, postponed: r?.postponed ?? 0 };
    });
    const sum = (k: 'total' | 'delivered' | 'cancelled' | 'inDelivery' | 'waiting' | 'postponed') => trend.reduce((s, x) => s + x[k], 0);
    const total = sum('total'), delivered = sum('delivered'), cancelled = sum('cancelled');
    const label = (r: string | null) => (r === 'POSTPONED' ? 'Жолооч хойшлуулсан' : r && r in CANCEL_LABEL ? CANCEL_LABEL[r as keyof typeof CANCEL_LABEL] : 'Шалтгаангүй');
    return {
      range, from, to,
      kpi: { total, delivered, cancelled, inDelivery: sum('inDelivery'), waiting: sum('waiting'), postponed: sum('postponed'), successRate: rate(delivered, total), cancelRate: rate(cancelled, total) },
      trend,
      reasons: reasons.map((r) => ({ key: r.reason ?? 'NONE', label: label(r.reason), n: r.n, pct: rate(r.n, cancelled) })),
      cancelledProducts: products,
      // Олон өдрийн хугацаанд — өдрийн дундаж (цаг бүрт)
      hourly: Array.from({ length: 24 }, (_, h) => ({ h, n: n > 1 ? Math.round(((hm.get(h) ?? 0) / n) * 10) / 10 : hm.get(h) ?? 0 })),
      hourlyAvg: n > 1,
      topSold: sold,
      pages: pages.map((p) => ({ ...p, rate: rate(p.delivered, p.total) })),
    };
  });
}

/**
 * Аудит #162 (эзэн): өдрийн эцсийн хяналт (өнөөдөр) — 21:00-аас хойш тод анхааруулна.
 * Оноогдоогүй (маргаашийн + үлдсэн), падаан хүлээн аваагүй жолооч, тооцоо илгээгээгүй / баталгаажаагүй.
 */
export async function endOfDay(actor: UserActor) {
  assertView(actor);
  const today = ubDay();
  return cached(`eod:${today}`, 30_000, async () => {
    const [r] = await db.$queryRaw<{ unassigned: number; notReceived: number; notSubmitted: number; notApproved: number; out: number }[]>`
      SELECT
        (SELECT count(*)::int FROM "Order" WHERE status = 'NEW' AND "driverId" IS NULL AND "deliveryDate" <= ${dateOnly(addDays(today, 1))}::date) AS unassigned,
        (SELECT count(*)::int FROM "Handover" WHERE date = ${dateOnly(today)}::date AND status <> 'RECEIVED') AS "notReceived",
        (SELECT count(*)::int FROM "Handover" h WHERE h.date = ${dateOnly(today)}::date AND h.status = 'RECEIVED'
           AND NOT EXISTS (SELECT 1 FROM "DriverSettlement" s WHERE s."driverId" = h."driverId" AND s.date = h.date AND s.status IN ('PENDING', 'COMPLETED'))) AS "notSubmitted",
        (SELECT count(*)::int FROM "DriverSettlement" WHERE date = ${dateOnly(today)}::date AND status = 'PENDING') AS "notApproved",
        (SELECT count(*)::int FROM "Order" o JOIN "Handover" h ON h.id = o."handoverId" WHERE h.date = ${dateOnly(today)}::date AND o.status = 'OUT_FOR_DELIVERY') AS out`;
    const hour = Number(new Date(Date.now() + 8 * 3600_000).toISOString().slice(11, 13));
    return { date: today, late: hour >= 21, ...r! };
  });
}

/** Анхаарах зүйлс — зөвхөн хэрэгтэй (0-ээс их) товчнууд, эрхээр */
export async function attention(actor: UserActor) {
  assertView(actor);
  const sa = actor.roles.includes('SUPER_ADMIN');
  const [boost, reorder, short, rec, disc, issues, edits, overpaid, late, stale] = await Promise.all([
    alertBanner(actor.roles).catch(() => null),
    reorderBanner(actor.roles).catch(() => null),
    canEdit(actor.roles, 'goods-outflow') ? pageShortView(actor).then((x) => x.rows.length).catch(() => 0) : Promise.resolve(0),
    reconcileAlert(actor.roles).catch(() => null),
    canReviewDiscounts(actor.roles) ? unreviewedDiscounts().catch(() => 0) : Promise.resolve(0),
    canView(actor.roles, 'issues') ? pendingIssueCount().catch(() => 0) : Promise.resolve(0),
    unreviewedCount(actor).catch(() => 0),
    cached('overpaid', 60_000, () => db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "Order" WHERE prepaid AND "paidAmount" > total AND status <> 'CANCELLED'`.then((r) => r[0]?.n ?? 0)).catch(() => 0),
    // Аудит #160: хүргэсний дараа хожуу буцаасан (сүүлийн 30 хоног), 7+ хоног буцаагаагүй бараатай жолооч — СА
    sa ? cached('late30', 60_000, () => db.order.count({ where: { lateCancelledAt: { gte: new Date(Date.now() - 30 * 86_400_000) } } })).catch(() => 0) : Promise.resolve(0),
    sa ? import('./accounting/debts').then((m) => m.staleGoodsAlert(actor.roles)).catch(() => null) : Promise.resolve(null),
  ]);
  const items: { key: string; tone: 'bad' | 'warn' | 'info'; icon: string; label: string; n: number; href: string }[] = [];
  if (rec) items.push({ key: 'reconcile', tone: 'bad', icon: '⚠', label: rec.kind === 'mismatch' ? 'Үлдэгдлийн тулгалтын зөрүү' : 'Автомат тулгалт ажиллаагүй', n: rec.status?.count ?? 1, href: '/warehouse' });
  if (boost?.red) items.push({ key: 'boost-red', tone: 'bad', icon: '🔴', label: 'Алдагдалтай бүүст', n: boost.red, href: '/goods-outflow?tab=red' });
  if (boost?.orange) items.push({ key: 'boost-orange', tone: 'warn', icon: '🟠', label: 'Ашиг бага / өсөлтгүй бүүст', n: boost.orange, href: '/goods-outflow?tab=orange' });
  if (short) items.push({ key: 'page-short', tone: 'warn', icon: '⚠', label: 'Гаралтаа хангаагүй пэйж (бараа)', n: short, href: '/goods-outflow?dlg=pageshort' });
  if (sa && reorder) {
    const u = reorder.urgent + reorder.late;
    items.push({ key: 'reorder', tone: u ? 'bad' : 'warn', icon: '🚚', label: 'Бараа татах', n: reorder.urgent + reorder.order + reorder.late, href: '/goods-outflow?tab=reorder' });
  }
  if (stale) items.push({ key: 'stale-goods', tone: 'bad', icon: '📦', label: `${stale.days}+ хоног бараагаа өгөөгүй жолооч (${stale.qty}ш)`, n: stale.drivers, href: '/accounting' });
  if (late) items.push({ key: 'late-returns', tone: 'warn', icon: '↩', label: 'Хүргэсний дараа буцаасан (30 хоног)', n: late, href: '/dashboard#late-returns' });
  if (issues) items.push({ key: 'issues', tone: 'warn', icon: '📞', label: '«Опп-руу явуулах» асуудал', n: issues, href: '/issues' });
  if (overpaid) items.push({ key: 'overpaid', tone: 'warn', icon: '↩', label: 'Илүү төлөлттэй захиалга — буцаах', n: overpaid, href: '/orders?overpaid=1' });
  if (disc) items.push({ key: 'discounts', tone: 'info', icon: '🏷', label: 'Шалгаагүй хөнгөлөлт / хүргэлтийн өөрчлөлт', n: disc, href: '/orders/review' });
  if (edits) items.push({ key: 'edits', tone: 'info', icon: '✎', label: 'Шалгаагүй барааны засвар', n: edits, href: '/products/history' });
  return { items };
}

/**
 * Аудит #160 (эзний шийдвэр): хүргэсний дараа (түгжсэн өдрөөс) үйлчлүүлэгч буцаасан захиалга — тусдаа, зөвхөн Супер админд.
 * Операторын цалин: цоожилсон хугацааных бол дараагийн цалингаас автоматаар хасагдана.
 */
export async function lateReturnList(actor: UserActor, pageIn: unknown) {
  if (!actor.roles.includes('SUPER_ADMIN')) throw forbidden('Зөвхөн Супер админ');
  const page = Math.max(1, Math.min(200, Math.floor(Number(pageIn) || 1)));
  const where = { lateCancelledAt: { not: null } } as const;
  const [items, total] = await Promise.all([
    db.order.findMany({ where, orderBy: { lateCancelledAt: 'desc' }, skip: (page - 1) * 30, take: 30,
      select: { id: true, number: true, phone: true, total: true, operatorName: true, driverName: true, deliveredAt: true, lateCancelledAt: true, lateCancelByName: true, lateCancelNote: true, createdAt: true } }),
    db.order.count({ where }),
  ]);
  return { items, total, page, pages: Math.max(1, Math.ceil(total / 30)) };
}
