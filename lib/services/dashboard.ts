import { Prisma } from '@prisma/client';
import { db } from '../db';
import { badRequest, forbidden } from '../errors';
import { canEdit, canReviewDiscounts, canView } from '../permissions';
import { isYmd, ubDay, ubDayStart, ymdOf } from '../ubdate';
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
    const [days, reasons, products] = await Promise.all([
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
    ]);
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
    };
  });
}

/** Анхаарах зүйлс — зөвхөн хэрэгтэй (0-ээс их) товчнууд, эрхээр */
export async function attention(actor: UserActor) {
  assertView(actor);
  const sa = actor.roles.includes('SUPER_ADMIN');
  const [boost, reorder, short, rec, disc, issues, edits] = await Promise.all([
    alertBanner(actor.roles).catch(() => null),
    reorderBanner(actor.roles).catch(() => null),
    canEdit(actor.roles, 'goods-outflow') ? pageShortView(actor).then((x) => x.rows.length).catch(() => 0) : Promise.resolve(0),
    reconcileAlert(actor.roles).catch(() => null),
    canReviewDiscounts(actor.roles) ? unreviewedDiscounts().catch(() => 0) : Promise.resolve(0),
    canView(actor.roles, 'issues') ? pendingIssueCount().catch(() => 0) : Promise.resolve(0),
    unreviewedCount(actor).catch(() => 0),
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
  if (issues) items.push({ key: 'issues', tone: 'warn', icon: '📞', label: '«Опп-руу явуулах» асуудал', n: issues, href: '/issues' });
  if (disc) items.push({ key: 'discounts', tone: 'info', icon: '🏷', label: 'Шалгаагүй хөнгөлөлт / хүргэлтийн өөрчлөлт', n: disc, href: '/orders/review' });
  if (edits) items.push({ key: 'edits', tone: 'info', icon: '✎', label: 'Шалгаагүй барааны засвар', n: edits, href: '/products/history' });
  return { items };
}
