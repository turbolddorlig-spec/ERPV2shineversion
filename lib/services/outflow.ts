import { Prisma, type Role } from '@prisma/client';
import { db } from '../db';
import { badRequest, conflict, forbidden, notFound } from '../errors';
import { writeAudit } from '../audit';
import { canEdit, canSeeCost } from '../permissions';
import { dateOnly, isYmd, ubDay, ubDayStart, ymdOf } from '../ubdate';
import { addDays } from './delivery/core';
import { productStockTotals } from './stock/views';
import type { UserActor } from './users';
import { withHeavy } from '../heavy';

type Tx = Prisma.TransactionClient;

/**
 * Модуль 7г — Барааны гарц ба маркетинг (#104–#110), хуучин «Барааны гарц»-ын логикоор + эзний шийдвэрүүд:
 *  • гарц = тухайн өдөр баталгаажсан (энгийн — үүссэн, урьдчилж төлсөн — мөнгө орсон) захиалгын ширхэг, төлбөр хүлээж буй орохгүй;
 *    тэр өдөртөө цуцлагдсан орохгүй, өдөр өнгөрсний дараах цуцлалт буулгахгүй («өдөр дуусахад бэхлэгдэнэ»); дундаж = 7 хоног ÷ 7;
 *  • бүүстийн ашиг (зөвхөн Супер админ мөнгө харна): ширхэгийн ашиг = үнэ − өртөг (эсвэл үнийн 35%) − опп − хүргэлт − бүүст/ширхэг;
 *    бүүстийн зардал = $ × бүүст × ханш, асаалттай цагаар; 💎 / 🟢 / 🟠 (< 1,500₮) / 🔴 (< 0);
 *  • анхааруулга: асаасан цагаас 8 цагт 0 захиалга → 🔴, 1 дээрээ гацвал → 🟠; өчигдрийн дүгнэлт (шинэ бүүст 1 өдөр, хэвийн бүүст 2 өдөр);
 *    «1 өдөр ажиглах» товч. Барааны үлдэгдэлд хүрэхгүй.
 */
const LEAD: Role[] = ['SUPER_ADMIN', 'ADMIN', 'MARKETING_LEAD'];
const MKT: Role[] = ['MARKETING', 'MARKETING_LEAD'];
const isLead = (a: UserActor) => a.roles.some((r) => LEAD.includes(r));
const isSA = (a: UserActor) => a.roles.includes('SUPER_ADMIN');
const assertView = (a: UserActor) => { if (!canEdit(a.roles, 'goods-outflow')) throw forbidden(); };
const assertLead = (a: UserActor) => { if (!isLead(a)) throw forbidden('Ахлах маркетинг, Админ, Супер админ хийнэ'); };
const assertSA = (a: UserActor) => { if (!isSA(a)) throw forbidden('Зөвхөн Супер админ'); };
const cleanInt = (v: unknown, label: string, min = 0, max = 1_000_000) => {
  const n = v === '' || v === null || v === undefined ? 0 : Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`${label} буруу`);
  return n;
};
const cleanText = (v: unknown, max: number) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const HOUR = 3_600_000;

// ───────────── Тохиргоо ─────────────
const KEY_CFG = 'outflow.config';
export interface OutflowConfig {
  claimTarget: number; claimExpireDays: number; watchHours: number; defaultDollar: number;
  oppCost: number; deliveryCost: number; rate: number; costPct: number; lowProfit: number;
  /** Нэг захиалгад энэ тооноос дээш ширхэг бол «бөөний» (#117) */
  bulkMin: number;
  /** Бараа дуусах анхааруулга: боломжтой ≤ (өдрийн хурд × энэ тоо) (#118) */
  stockDays: number;
  /** Бараа татах (#119, СА): Хятадаас ирэх хоног — нөөц ≤ энэ бол 🟠; ≤ urgentDays бол 🔴 */
  leadDays: number; urgentDays: number;
  /** Нийлүүлэгчийн дэлгүүрт оноосон барааг СА-ын «Бараа татах»-д харуулахгүй (#120) */
  hideSupplierReorder: boolean;
}
export const DEFAULT_CFG: OutflowConfig = { claimTarget: 5, claimExpireDays: 7, watchHours: 8, defaultDollar: 5, oppCost: 1200, deliveryCost: 5000, rate: 3600, costPct: 35, lowProfit: 1500, bulkMin: 5, stockDays: 1, leadDays: 15, urgentDays: 7, hideSupplierReorder: true };
let cfgCache: { at: number; v: OutflowConfig } | null = null;
export async function getConfig(tx: Tx | typeof db = db): Promise<OutflowConfig> {
  if (tx === db && cfgCache && Date.now() - cfgCache.at < 30_000) return cfgCache.v;
  const r = await tx.appSetting.findUnique({ where: { key: KEY_CFG } });
  const v = { ...DEFAULT_CFG, ...((r?.value ?? {}) as Partial<OutflowConfig>) };
  if (tx === db) cfgCache = { at: Date.now(), v };
  return v;
}
/** Тохиргоо харах: мөнгөн утгууд (опп, хүргэлт, ханш, өртгийн %, босго) — зөвхөн Супер админд */
export async function configView(actor: UserActor) {
  assertView(actor);
  const c = await getConfig();
  if (isSA(actor)) return c;
  return { claimTarget: c.claimTarget, claimExpireDays: c.claimExpireDays, stockDays: c.stockDays };
}
/** Ажлын цонхны тоо, хоног — Ахлах/Админ/СА; мөнгөн зардал, ханш, босго, цаг — зөвхөн Супер админ */
export async function setConfig(actor: UserActor, b: Record<string, unknown>) {
  assertLead(actor);
  const cur = await getConfig();
  const next: OutflowConfig = { ...cur };
  if (b.claimTarget !== undefined) next.claimTarget = cleanInt(b.claimTarget, '«Хийсэн» захиалгын тоо', 1, 1000);
  if (b.claimExpireDays !== undefined) next.claimExpireDays = cleanInt(b.claimExpireDays, 'Чөлөөлөх хоног', 1, 365);
  if (b.stockDays !== undefined) next.stockDays = cleanInt(b.stockDays, 'Дуусах анхааруулга (өдөр)', 1, 30);
  if (b.hideSupplierReorder !== undefined) { assertSA(actor); next.hideSupplierReorder = b.hideSupplierReorder === true || b.hideSupplierReorder === 'true'; }
  const money = ['oppCost', 'deliveryCost', 'rate', 'costPct', 'lowProfit', 'watchHours', 'defaultDollar', 'bulkMin', 'leadDays', 'urgentDays'] as const;
  if (money.some((k) => b[k] !== undefined)) {
    assertSA(actor);
    if (b.oppCost !== undefined) next.oppCost = cleanInt(b.oppCost, 'Опп цалин', 0, 1_000_000);
    if (b.deliveryCost !== undefined) next.deliveryCost = cleanInt(b.deliveryCost, 'Хүргэлтийн цалин', 0, 1_000_000);
    if (b.rate !== undefined) next.rate = cleanInt(b.rate, 'Долларын ханш', 1, 100_000);
    if (b.costPct !== undefined) next.costPct = cleanInt(b.costPct, 'Өртгийн хувь', 0, 100);
    if (b.lowProfit !== undefined) next.lowProfit = cleanInt(b.lowProfit, 'Ашгийн босго', 0, 10_000_000);
    if (b.watchHours !== undefined) next.watchHours = cleanInt(b.watchHours, 'Ажиглах цаг', 1, 24);
    if (b.defaultDollar !== undefined) next.defaultDollar = cleanInt(b.defaultDollar, 'Анхдагч $', 1, 10_000);
    if (b.bulkMin !== undefined) next.bulkMin = cleanInt(b.bulkMin, 'Бөөний захиалгын ширхэг', 2, 100_000);
    if (b.leadDays !== undefined) next.leadDays = cleanInt(b.leadDays, 'Бараа ирэх хоног', 1, 180);
    if (b.urgentDays !== undefined) next.urgentDays = cleanInt(b.urgentDays, 'Яаралтай хоног', 0, 180);
    if (next.urgentDays >= next.leadDays) throw badRequest('Яаралтай хоног нь ирэх хоногоос бага байна');
  }
  const json = next as unknown as Prisma.InputJsonValue;
  await db.$transaction(async (tx) => {
    await tx.appSetting.upsert({ where: { key: KEY_CFG }, create: { key: KEY_CFG, value: json, updatedById: actor.id }, update: { value: json, updatedById: actor.id } });
    await writeAudit(actor, 'outflow.config', 'AppSetting', KEY_CFG, { before: cur, after: next } as unknown as Prisma.InputJsonValue, tx, ['money']);
  });
  cfgCache = null; bustReorder();
  return next;
}

// ───────────── Гарцын тоолол (нэг дүрэм — бүх цонхонд) ─────────────

/** «Тоологдох» захиалга: төлбөр хүлээж буйгаас бусад; тэр өдөртөө (баталгаажсан UB өдөр) цуцлагдсан орохгүй */
// Аудит Б22: нэг удаа баталгаажсан (confirmedAt) захиалга дараа нь «Төлбөр хүлээж буй» руу буцсан ч анхны өдөртөө тоологдоно
const COUNTED = Prisma.sql`o."confirmedAt" IS NOT NULL
  AND NOT (o.status = 'CANCELLED' AND (o."cancelledAt" IS NULL OR (o."cancelledAt" + interval '8 hours')::date <= (o."confirmedAt" + interval '8 hours')::date))`;
/** Одоогийн (амьд) тоолол — цуцлагдсан бүгд хасагдана (ажлын цонхны «Хийсэн») */
const LIVE = Prisma.sql`o.status NOT IN ('PENDING_PAYMENT', 'CANCELLED') AND o."confirmedAt" IS NOT NULL`;

interface DayAgg { productId: number; day: string; qty: number; revenue: number; orderShare: number; orders: number; bulkOrders: number; bulkQty: number }
export async function unitsByDay(from: string, to: string, productIds?: number[]): Promise<DayAgg[]> {
  const pf = productIds ? (productIds.length ? Prisma.sql`AND l."productId" IN (${Prisma.join(productIds)})` : Prisma.sql`AND false`) : Prisma.empty;
  const bulkMin = (await getConfig()).bulkMin;
  // Захиалга × бараа бүрээр нэгтгээд (нэг захиалгад олон өнгө байж болно) бөөнийг ялгана
  const rows = await db.$queryRaw<{ productId: number; day: Date; qty: number; revenue: number; orders: number; bulkOrders: number; bulkQty: number }[]>`
    SELECT x."productId", x.day, sum(x.q)::int AS qty, sum(x.v)::bigint AS revenue, count(*)::int AS orders,
           count(*) FILTER (WHERE x.q >= ${bulkMin})::int AS "bulkOrders", coalesce(sum(x.q) FILTER (WHERE x.q >= ${bulkMin}), 0)::int AS "bulkQty"
    FROM (
      SELECT l."productId", o.id, (o."confirmedAt" + interval '8 hours')::date AS day, sum(l.qty) AS q, sum(l.qty * l."unitPrice") AS v
      FROM "Order" o JOIN "OrderLine" l ON l."orderId" = o.id
      WHERE o."confirmedAt" >= ${ubDayStart(from)} AND o."confirmedAt" < ${ubDayStart(addDays(to, 1))} AND ${COUNTED} ${pf}
      GROUP BY 1, 2, 3
    ) x GROUP BY 1, 2`;
  return rows.map((r) => ({ productId: r.productId, day: ymdOf(r.day), qty: r.qty, revenue: Number(r.revenue), orderShare: r.orders, orders: r.orders, bulkOrders: r.bulkOrders, bulkQty: r.bulkQty }));
}

// ───────────── Бүүстийн цагийн хуваарь ба зардал ─────────────

interface Seg { from: number; to: number; dollar: number; zones: number }
/** Бараа бүрийн бүүстийн хэсгүүд [from, to) — BoostEvent-ээс (өмнөх хамгийн сүүлийн төлвөөс эхлэн) */
async function boostSegments(productIds: number[], fromMs: number, toMs: number): Promise<Map<number, Seg[]>> {
  const out = new Map<number, Seg[]>();
  if (!productIds.length) return out;
  const evs = await db.$queryRaw<{ productId: number; at: Date; dollar: number; zones: number }[]>`
    SELECT "productId", at, dollar, zones FROM "BoostEvent" WHERE "productId" IN (${Prisma.join(productIds)}) AND at >= ${new Date(fromMs)} AND at < ${new Date(toMs)}
    UNION ALL
    -- Цонхны өмнөх ХАМГИЙН СҮҮЛИЙН төлөв (аудит А1: өмнө нь дэд асуулгад ORDER BY байгаагүй тул хамгийн эхнийх нь сонгогддог байв)
    (SELECT DISTINCT ON ("productId") "productId", at, dollar, zones FROM "BoostEvent" WHERE "productId" IN (${Prisma.join(productIds)}) AND at < ${new Date(fromMs)}
     ORDER BY "productId", at DESC, id DESC)
    ORDER BY 1, 2`;
  const by = new Map<number, typeof evs>();
  for (const e of evs) { const a = by.get(e.productId) ?? []; a.push(e); by.set(e.productId, a); }
  for (const [pid, list] of by) {
    list.sort((a, b) => a.at.getTime() - b.at.getTime());
    const segs: Seg[] = [];
    for (let i = 0; i < list.length; i++) {
      const e = list[i]!;
      if (e.zones <= 0) continue;
      const s = Math.max(e.at.getTime(), fromMs);
      const t = Math.min(i + 1 < list.length ? list[i + 1]!.at.getTime() : toMs, toMs);
      if (t > s) segs.push({ from: s, to: t, dollar: e.dollar, zones: e.zones });
    }
    out.set(pid, segs);
  }
  return out;
}
/**
 * Өдрийн бүүстийн төлөв — эзний шийдвэр (#153): тухайн өдөр асаалттай байсан хамгийн их төлөв ($ × бүүстийн тоо).
 * Зорилт = бүүстийн тоо × $ захиалга (1 захиалга = $1). Зардал: захиалга бүрт 1$ (ханш, 3,600₮);
 * асаалттай мөртлөө 0 захиалга бол зарцуулсан бүтэн дүн ($ × бүүст × ханш).
 */
type Peak = { dollar: number; zones: number } | null;
/** Хугацаанд бүүст хамгийн их байсан төлөв (үнэлгээ: хүлээгдэж буй = бүс × $) */
const peakBoost = (segs: Seg[] | undefined, fromMs: number, toMs: number) =>
  (segs ?? []).filter((g) => g.to > fromMs && g.from < toMs).reduce<{ dollar: number; zones: number } | null>((m, g) => (!m || g.zones * g.dollar > m.zones * m.dollar ? { dollar: g.dollar, zones: g.zones } : m), null);

// ───────────── Бүүстийн ашиг ─────────────

export type ProfitStatus = 'DIAMOND' | 'GOOD' | 'LOW' | 'LOSS';
export interface DayProfit {
  day: string; qty: number; orders: number; revenue: number; cost: number; costEstimated: boolean; oppDelivery: number; boost: number;
  /** Зорилт (захиалга) = бүүстийн тоо × $; бүүстгүй өдөр 0 */
  target: number;
  profit: number; perUnit: number | null; status: ProfitStatus | null;
}
function profitOf(cfg: OutflowConfig, p: { price: number; costPrice: number | null }, a: { qty: number; revenue: number; orders: number } | undefined, pk: Peak, day: string): DayProfit {
  const qty = a?.qty ?? 0, revenue = a?.revenue ?? 0;
  const unitCost = p.costPrice ?? Math.round((p.price * cfg.costPct) / 100);
  const cost = qty * unitCost;
  // Эзний шийдвэр (#117): опп + хүргэлт ЗАХИАЛГА бүрээс (нэг хаягт нэг удаа); үр дүнг ЗАХИАЛГААР хэмжинэ (бөөний нэг захиалга = 1)
  const orders = a?.orders ?? 0;
  const oppDelivery = orders * (cfg.oppCost + cfg.deliveryCost);
  // Эзний шийдвэр (#153): зорилт = бүүстийн тоо × $ захиалга; бүүстийн зардал захиалга бүрт ханш (1$),
  // асаалттай мөртлөө 0 захиалга бол өдөрт зарцуулсан бүтэн дүн
  const target = pk ? pk.zones * pk.dollar : 0;
  const boost = !pk ? 0 : orders > 0 ? orders * cfg.rate : target * cfg.rate;
  const profit = revenue - cost - oppDelivery - boost;
  /** Нэг захиалгын ашиг */
  const perUnit = orders > 0 ? Math.round(profit / orders) : boost > 0 ? -boost : null;
  // Төлөв зорилтоор: 💎 ≥150%, 🟢 ≥100%, 🟠 ≥80%, 🔴 доош; үнэ нь өөрөө алдагдалтай (захиалгын ашиг < 0) бол 🔴
  let status: ProfitStatus | null = null;
  if (target > 0) {
    const r = orders / target;
    if (perUnit === null || perUnit < 0 || r < 0.8) status = 'LOSS';
    else if (r < 1) status = 'LOW';
    else status = r >= 1.5 ? 'DIAMOND' : 'GOOD';
  }
  return { day, qty, orders: a?.orders ?? 0, revenue, cost, costEstimated: p.costPrice === null, oppDelivery, boost, target, profit, perUnit, status };
}

// ───────────── Анхааруулга ─────────────

export type AlertLevel = 'RED' | 'ORANGE';
export interface BoostAlert {
  productId: number; code: string; name: string; level: AlertLevel; reasons: string[]; pages: { name: string; n: number }[];
  watchedUntil: Date | null; watchedBy: string | null; boostOnAt: Date | null; zones: number; dollar: number; ownerName: string | null;
}
let alertCache: { at: number; list: BoostAlert[] } | null = null;
/** Кэш хүчингүй болох бүрт нэмэгдэнэ — өмнө эхэлсэн тооцоо хуучин үр дүнгээ кэшлэхгүй */
let alertGen = 0;
export function bustOutflowCache() { alertCache = null; alertGen++; bustReorder(); shortCache = null; shortGen++; cfgCache = null; profCache = null; }
/** Тест: кэшгүй (тест бүр шууд database-ээс) */
const CACHE_MS = process.env.NODE_ENV === 'test' ? 0 : 60_000;

/** Одоо бүүст асаалттай бараануудын анхааруулга (60 сек кэш) */
let alertInflight: { gen: number; p: Promise<BoostAlert[]> } | null = null;
export async function computeAlerts(fresh = false): Promise<BoostAlert[]> {
  if (!fresh && alertCache && Date.now() - alertCache.at < 60_000) return alertCache.list;
  // Аудит #152: зэрэг олон хүсэлт нэг л удаа тооцоолно (кэш цэвэрлэгдсэний дараах «бөөнөөр» тооцоолол)
  if (!fresh && alertInflight && alertInflight.gen === alertGen) return alertInflight.p;
  const gen = alertGen;
  const p = computeAlertsNow(gen); if (!fresh) alertInflight = { gen, p };
  try { return await p; } finally { if (alertInflight?.p === p) alertInflight = null; }
}
async function computeAlertsNow(gen: number): Promise<BoostAlert[]> {
  const cfg = await getConfig();
  const now = Date.now();
  const today = ubDay(); const yest = addDays(today, -1); const d2 = addDays(today, -2);
  const todayStart = ubDayStart(today).getTime(), yStart = ubDayStart(yest).getTime(), d2Start = ubDayStart(d2).getTime();
  const pms = await db.productMarketing.findMany({ where: { zones: { gt: 0 } } });
  if (!pms.length) { if (gen === alertGen) alertCache = { at: now, list: [] }; return []; }
  const ids = pms.map((x) => x.productId);
  const [products, segs, aggs, watches, stock] = await Promise.all([
    // Аудит А11: архивласан барааны анхааруулга гаргахгүй (pmap-д ороогүй бол алгасагдана)
    db.product.findMany({ where: { id: { in: ids }, status: { not: 'ARCHIVED' } }, select: { id: true, code: true, name: true, price: true, costPrice: true } }),
    boostSegments(ids, d2Start, now),
    unitsByDay(addDays(today, -3), today, ids),
    db.boostWatch.findMany({ where: { productId: { in: ids }, until: { gt: new Date(now) } }, orderBy: { until: 'desc' } }),
    productStockTotals(ids),
  ]);
  const pmap = new Map(products.map((p) => [p.id, p]));
  const aggMap = new Map(aggs.map((a) => [`${a.productId}|${a.day}`, a]));
  const watchMap = new Map<number, (typeof watches)[number]>(); for (const w of watches) if (!watchMap.has(w.productId)) watchMap.set(w.productId, w);
  // Өнөөдөр бүүст асаасан цагаас хойшх захиалга (амьд тоолол), пэйжээр
  // since ≥ min(24 цагийн өмнө, өнөөдрийн эхлэл) үргэлж — тиймээс захиалгыг тэр хугацаагаар хязгаарлана
  // (өмнө нь захиалгын бүх мөрийг (2 сая) уншдаг байсан — 0.7 сек, аудит №3). Үр дүн ижил.
  const sinceLb = new Date(Math.min(now - 24 * HOUR, todayStart));
  const sinceRows = await db.$queryRaw<{ productId: number; since: Date; orders: number }[]>`
    WITH x AS (SELECT "productId", CASE WHEN "boostOnAt" > ${new Date(now - 24 * HOUR)} THEN "boostOnAt" ELSE GREATEST("boostOnAt", ${new Date(todayStart)}) END AS since
          FROM "ProductMarketing" WHERE zones > 0 AND "boostOnAt" IS NOT NULL),
    c AS (SELECT l."productId", o.id, o."confirmedAt" FROM "Order" o JOIN "OrderLine" l ON l."orderId" = o.id
          WHERE o."confirmedAt" >= ${sinceLb} AND ${LIVE} AND l."productId" IN (SELECT "productId" FROM x))
    SELECT x."productId", x.since, count(DISTINCT c.id) FILTER (WHERE c."confirmedAt" >= x.since)::int AS orders
    FROM x LEFT JOIN c ON c."productId" = x."productId"
    GROUP BY 1, 2`;
  const since = new Map(sinceRows.map((r) => [r.productId, r]));
  // Асаалттай байх үедээ $ буурсан эсэх (сүүлийн 48 цаг)
  const recentEv = await db.boostEvent.findMany({ where: { productId: { in: ids }, at: { gte: new Date(now - 48 * HOUR) } }, orderBy: [{ productId: 'asc' }, { at: 'asc' }], select: { productId: true, at: true, dollar: true, zones: true, byName: true } });
  const prevEv = await db.$queryRaw<{ productId: number; dollar: number; zones: number }[]>`
    SELECT DISTINCT ON ("productId") "productId", dollar, zones FROM "BoostEvent" WHERE "productId" = ANY(${ids}::int[]) AND at < ${new Date(now - 48 * HOUR)} ORDER BY "productId", at DESC`;
  const lastState = new Map(prevEv.map((e) => [e.productId, e]));
  const dollarDrops = new Map<number, { from: number; to: number; by: string }>();
  for (const e of recentEv) {
    const prev = lastState.get(e.productId);
    if (prev && prev.zones > 0 && e.zones > 0 && e.dollar < prev.dollar) dollarDrops.set(e.productId, { from: prev.dollar, to: e.dollar, by: e.byName });
    lastState.set(e.productId, { productId: e.productId, dollar: e.dollar, zones: e.zones });
  }
  const list: BoostAlert[] = [];
  const pageDays = new Map<number, string>();
  for (const pm of pms) {
    const p = pmap.get(pm.productId); if (!p) continue;
    const reasons: string[] = []; let level: AlertLevel | null = null;
    const up = (l: AlertLevel, why: string) => { reasons.push(why); if (l === 'RED' || !level) level = l; };
    // 1) Өдрийн дундах: асаасан цагаас (24 цагаас өмнө асаасан бол өнөөдрийн эхлэлээс) N цаг
    const s = since.get(pm.productId);
    if (s && now - s.since.getTime() >= cfg.watchHours * HOUR) {
      if (s.orders === 0) up('RED', `Бүүст асаалттай ${cfg.watchHours}+ цаг — захиалга алга. Шалгах эсвэл унтраах`);
      else if (s.orders === 1) up('ORANGE', `Өсөлтгүй бүүст — ${cfg.watchHours}+ цагт 1 л захиалга`);
      pageDays.set(pm.productId, today);
    }
    // 2) Өчигдрийн дүгнэлт (бүүст тэр өдөр асаалттай байсан бол)
    const sg = segs.get(pm.productId);
    const yb = peakBoost(sg, yStart, todayStart);
    if (yb) {
      const y = profitOf(cfg, p, aggMap.get(`${pm.productId}|${yest}`), yb, yest);
      const isNew = !!pm.boostOnAt && pm.boostOnAt.getTime() >= d2Start;
      if (y.status === 'LOSS') {
        const b2 = peakBoost(sg, d2Start, yStart);
        const prev = b2 ? profitOf(cfg, p, aggMap.get(`${pm.productId}|${d2}`), b2, d2) : null;
        const got = `${y.orders}/${y.target} захиалга`;
        if (isNew) up('RED', `Зорилт хангаагүй бүүст (шинэ бүүст, өчигдөр ${got}) — яаралтай унтраа`);
        else if (prev?.status === 'LOSS') up('RED', `Зорилт хангаагүй бүүст — дараалан 2 өдөр (өчигдөр ${got}), яаралтай унтраа`);
        else up('ORANGE', `Өчигдөр зорилт хангаагүй (${got}) — ажиглаж байна (маргааш давтагдвал яаралтай)`);
      } else if (y.status === 'LOW') up('ORANGE', `Зорилтод бага зэрэг хүрээгүй (өчигдөр ${y.orders}/${y.target} захиалга) — бүүстээ шалгана уу`);
      if (!pageDays.has(pm.productId) && level) pageDays.set(pm.productId, yest);
    }
    // Аудит #152 (эзний шийдвэр): асаалттай бүүстийн $-ыг сүүлийн 2 хоногт багасгасан бол — алдагдал нуух эрсдэл, Супер админд харагдана
    const dl = dollarDrops.get(pm.productId);
    if (dl) up('ORANGE', `Асаалттай бүүстийн $ багасгасан: $${dl.from} → $${dl.to} (${dl.by}) — бодит зардалтай тулгана уу`);
    // 3) Бараа дуусах (#118): хурд = сүүлийн 3 бүтэн өдрийн дундаж (бөөнгүй), өнөөдөр түүнээс хурдан бол өнөөдрийнх
    {
      const avail = stock.get(pm.productId)?.available ?? 0;
      const net = (d: string) => { const a = aggMap.get(`${pm.productId}|${d}`); return a ? a.qty - a.bulkQty : 0; };
      const pace = Math.max((net(yest) + net(d2) + net(addDays(today, -3))) / 3, net(today));
      if (avail <= 0) up('RED', `Бараа дууссан (боломжтой ${avail}) — бүүстээ шууд унтраа`);
      else if (pace > 0 && avail <= pace * cfg.stockDays) up('ORANGE', `Бараа дуусах дөхсөн: боломжтой ${avail}, өдөрт ~${Math.round(pace)} гардаг — бүүстээ унтрааж хэмнэ`);
    }
    if (!level) continue;
    const w = watchMap.get(pm.productId);
    list.push({ productId: p.id, code: p.code, name: p.name, level, reasons, pages: [], watchedUntil: w?.until ?? null, watchedBy: w?.byName ?? null,
      boostOnAt: pm.boostOnAt, zones: pm.zones, dollar: pm.dollar, ownerName: pm.ownerName });
  }
  // Пэйж бүрийн захиалга (анхааруулгын өдрөөр) — аль пэйж дээрх бүүст ажиллахгүй байгааг харуулна
  if (list.length) {
    const pg = await pagesFor(list.map((a) => a.productId), [today, yest]);
    for (const a of list) a.pages = pg.get(`${a.productId}|${pageDays.get(a.productId) ?? today}`) ?? [];
  }
  list.sort((a, b) => (a.level === b.level ? a.name.localeCompare(b.name) : a.level === 'RED' ? -1 : 1));
  if (gen === alertGen) alertCache = { at: now, list };
  return list;
}

async function pagesFor(productIds: number[], days: string[]) {
  const out = new Map<string, { name: string; n: number }[]>();
  if (!productIds.length || !days.length) return out;
  const from = [...days].sort()[0]!, to = [...days].sort().at(-1)!;
  const rows = await db.$queryRaw<{ productId: number; day: Date; name: string; n: number }[]>`
    SELECT l."productId", (o."confirmedAt" + interval '8 hours')::date AS day, p.name, sum(l.qty)::int AS n
    FROM "Order" o JOIN "OrderLine" l ON l."orderId" = o.id JOIN "Page" p ON p.id = o."pageId"
    WHERE o."confirmedAt" >= ${ubDayStart(from)} AND o."confirmedAt" < ${ubDayStart(addDays(to, 1))} AND ${COUNTED} AND l."productId" IN (${Prisma.join(productIds)})
    GROUP BY 1, 2, 3 ORDER BY 4 DESC`;
  for (const r of rows) { const k = `${r.productId}|${ymdOf(r.day)}`; const a = out.get(k) ?? []; a.push({ name: r.name, n: r.n }); out.set(k, a); }
  return out;
}

/** Бүх хуудасны дээрх сануулга (СА, Админ, маркетинг): ажиглаагүй 🔴 / 🟠 тоо */
export async function alertBanner(roles: Role[]): Promise<{ red: number; orange: number } | null> {
  if (!roles.some((r) => [...LEAD, ...MKT].includes(r))) return null;
  const list = await computeAlerts();
  const now = Date.now();
  const open = list.filter((a) => !a.watchedUntil || a.watchedUntil.getTime() <= now);
  // Аудит #152 (эзний шийдвэр): Супер админд 🔴 «ажиглаж буй» байсан ч үргэлж харагдана
  const sa = roles.includes('SUPER_ADMIN');
  const red = (sa ? list : open).filter((a) => a.level === 'RED').length, orange = open.filter((a) => a.level === 'ORANGE').length;
  return red || orange ? { red, orange } : null;
}

export async function alertsView(actor: UserActor) {
  assertView(actor);
  const list = await computeAlerts();
  const now = Date.now();
  const watched = list.filter((a) => a.watchedUntil && a.watchedUntil.getTime() > now);
  const open = list.filter((a) => !watched.includes(a));
  return { red: open.filter((a) => a.level === 'RED'), orange: open.filter((a) => a.level === 'ORANGE'), watched };
}

/** «1 өдөр ажиглах» — 24 цаг нууна; дараа нь нөхцөл хэвээр бол дахин гарна */
export async function watchProduct(actor: UserActor, productIdIn: unknown) {
  assertView(actor);
  const productId = Number(productIdIn);
  const p = await db.product.findUnique({ where: { id: productId }, select: { code: true, name: true } });
  if (!p) throw notFound('Бараа олдсонгүй');
  const until = new Date(Date.now() + 24 * HOUR);
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(7400, ${productId}::int)`;
    // Аудит #152: нэг анхааруулгад нэг л удаа — ажиглаж буй эсвэл ажиглалт дууссанаас 24 цаг болоогүй бол дахин ажиглахгүй
    const last = await tx.boostWatch.findFirst({ where: { productId }, orderBy: { until: 'desc' } });
    if (last && last.until.getTime() > Date.now() - 24 * HOUR) throw conflict(last.until.getTime() > Date.now() ? `${last.byName} аль хэдийн ажиглаж байна` : 'Ажиглалт саяхан дууссан — бүүстийг шалгаж шийдвэр гаргана уу (дахин ажиглахгүй)', 'watched');
    await tx.boostWatch.create({ data: { productId, until, byId: actor.id, byName: actor.name } });
    await writeAudit(actor, 'outflow.watch', 'ProductMarketing', String(productId), { product: `${p.code} ${p.name}`, until }, tx);
  });
  bustOutflowCache();
  return { until };
}

// ───────────── 7 хоногийн гарцын хүснэгт ─────────────

export interface OutflowRow {
  id: number; code: string; name: string; price: number; imageKey: string | null;
  dollar: number; zones: number; adNumber: number | null; ownerId: string | null; ownerName: string | null; doneAt: Date | null; doneByName: string | null; note: string;
  daily: number[]; weekTotal: number; avg: number; phones: number[]; phoneWeek: number; variantCount: number;
  /** Бөөний захиалга өдөр бүр: тоо ба ширхэг (#117) — өнгө, дунджид орохгүй */
  bulk: { n: number; qty: number }[];
  stock?: { total: number; available: number; driver: number };
  alert?: AlertLevel | null; profit?: { status: ProfitStatus | null; perUnit: number | null; orders: number; target: number } | null;
  /** Мөрийн ард жижиг тэмдэг — дарахад дэлгэрэнгүй */
  alertInfo?: { level: AlertLevel; reasons: string[]; pages: { name: string; n: number }[]; watchedUntil: Date | null; watchedBy: string | null } | null;
  /** Нөөц хоног ба бараа татах (#119) — зөвхөн Супер админ */
  reorder?: ReorderInfo | null;
}

async function phoneCounts(from: string, to: string) {
  const rows = await db.$queryRaw<{ productId: number; day: Date | null; n: number }[]>`
    SELECT v."productId", (c."createdAt" + interval '8 hours')::date AS day, count(DISTINCT c.phone)::int AS n
    FROM "CallNote" c JOIN "ProductVariant" v ON v.id = c."variantId"
    WHERE c."createdAt" >= ${ubDayStart(from)} AND c."createdAt" < ${ubDayStart(addDays(to, 1))}
    GROUP BY GROUPING SETS ((1, 2), (1))`;
  return rows;
}

export interface TableParams { q?: string; tab?: string; zone?: string; owner?: string; dollar?: string; status?: string; sort?: string; dir?: string; page?: number }
const PAGE = 50;
let tableCache: { at: number; key: string; rows: OutflowRow[] } | null = null;

/**
 * Аудит #152 (хурд): хүснэгт санах ойд — 20 сек «шинэ», 5 мин хүртэл хуучнаа шууд өгч ар талд НЭГ л удаа шинэчилнэ
 * (хэрэглэгч тооцоолол хүлээхгүй). Кэш хүчингүй болсны (tableGen) өмнө эхэлсэн тооцоо хуучин үр дүнгээ кэшлэхгүй.
 */
const TABLE_FRESH_MS = process.env.NODE_ENV === 'test' ? 0 : 20_000;
const TABLE_STALE_MS = process.env.NODE_ENV === 'test' ? 0 : 5 * 60_000;
let tableGen = 0;
let rowsInflight: { key: string; gen: number; p: Promise<OutflowRow[]> } | null = null;
async function allRows(): Promise<OutflowRow[]> {
  const k = ubDay(); const c = tableCache;
  if (c && c.key === k) {
    const age = Date.now() - c.at;
    if (age < TABLE_FRESH_MS) return c.rows;
    if (age < TABLE_STALE_MS) { refreshRows(k).catch(() => undefined); return c.rows; }
  }
  return refreshRows(k);
}
function refreshRows(k: string): Promise<OutflowRow[]> {
  if (rowsInflight && rowsInflight.key === k && rowsInflight.gen === tableGen) return rowsInflight.p;
  const gen = tableGen;
  const p = allRowsNow(gen);
  rowsInflight = { key: k, gen, p };
  p.finally(() => { if (rowsInflight?.p === p) rowsInflight = null; }).catch(() => undefined);
  return p;
}
async function allRowsNow(gen: number): Promise<OutflowRow[]> {
  const today = ubDay(); const from = addDays(today, -6);
  const k = today;
  const [products, pms, aggs, phones] = await Promise.all([
    db.product.findMany({ where: { status: { not: 'ARCHIVED' } }, select: { id: true, code: true, name: true, price: true, images: { where: { isMain: true }, select: { fileKey: true }, take: 1 }, _count: { select: { variants: { where: { isActive: true } } } } } }),
    db.productMarketing.findMany(),
    unitsByDay(from, today),
    phoneCounts(from, today),
  ]);
  const pm = new Map(pms.map((x) => [x.productId, x]));
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, -i));
  const di = new Map(days.map((d, i) => [d, i]));
  const daily = new Map<number, number[]>();
  const bulkM = new Map<number, { n: number; qty: number }[]>();
  for (const a of aggs) {
    const i = di.get(a.day); if (i === undefined) continue;
    const arr = daily.get(a.productId) ?? Array(7).fill(0); arr[i] += a.qty; daily.set(a.productId, arr);
    if (a.bulkOrders) { const b = bulkM.get(a.productId) ?? Array.from({ length: 7 }, () => ({ n: 0, qty: 0 })); b[i]!.n += a.bulkOrders; b[i]!.qty += a.bulkQty; bulkM.set(a.productId, b); }
  }
  const ph = new Map<number, number[]>(); const phW = new Map<number, number>();
  for (const r of phones) {
    if (r.day === null) { phW.set(r.productId, r.n); continue; }
    const i = di.get(ymdOf(r.day)); if (i === undefined) continue;
    const arr = ph.get(r.productId) ?? Array(7).fill(0); arr[i] = r.n; ph.set(r.productId, arr);
  }
  const rows = products.map((p) => {
    const m = pm.get(p.id);
    const d = daily.get(p.id) ?? Array(7).fill(0);
    const week = d.reduce((s, n) => s + n, 0);
    const img = p.images[0]?.fileKey ?? null;
    return {
      id: p.id, code: p.code, name: p.name, price: p.price, imageKey: img,
      dollar: m?.dollar ?? 5, zones: m?.zones ?? 0, adNumber: m?.adNumber ?? null, ownerId: m?.ownerId ?? null, ownerName: m?.ownerName ?? null,
      doneAt: m?.doneAt ?? null, doneByName: m?.doneByName ?? null, note: m?.note ?? '',
      daily: d, weekTotal: week, phones: ph.get(p.id) ?? Array(7).fill(0), phoneWeek: phW.get(p.id) ?? 0, variantCount: p._count.variants,
      bulk: bulkM.get(p.id) ?? Array.from({ length: 7 }, () => ({ n: 0, qty: 0 })),
      avg: Math.round(((week - (bulkM.get(p.id) ?? []).reduce((s, x) => s + x.qty, 0)) / 7) * 10) / 10,
    } as OutflowRow;
  });
  if (gen === tableGen) tableCache = { at: Date.now(), key: k, rows };
  return rows;
}
export function bustTable() { tableCache = null; tableGen++; profCache = null; }
/** Нэг барааны өөрчлөлтийг (бүүст, тэмдэглэл, хариуцагч) бүх хүснэгтийг дахин бодолгүй кэшэнд шууд тусгана */
function patchRows(ids: number[], fn: (r: OutflowRow) => void) {
  tableGen++; // өмнө эхэлсэн тооцоо энэ өөрчлөлтгүй — кэшлэхгүй
  const c = tableCache; if (!c) return;
  const set = new Set(ids);
  // Шинэ массив — уншиж буй хүсэлтийн мөрүүд дундуур өөрчлөгдөхгүй
  c.rows = c.rows.map((r) => { if (!set.has(r.id)) return r; const x = { ...r }; fn(x); return x; });
}

/** Хүснэгт — серверт шүүж, эрэмбэлж, 50-аар хуудаслана */
export async function outflowTable(actor: UserActor, p: TableParams) {
  assertView(actor);
  const sa = canSeeCost(actor.roles) && isSA(actor);
  let rows = await allRows();
  const alerts = await computeAlerts();
  const alertMap = new Map(alerts.map((a) => [a.productId, a]));
  const now = Date.now();
  const q = cleanText(p.q, 60).toLowerCase();
  if (q) rows = rows.filter((r) => r.name.toLowerCase().includes(q) || r.code.toLowerCase().includes(q));
  if (p.tab === 'boost') rows = rows.filter((r) => r.zones > 0);
  if (p.tab === 'noboost') rows = rows.filter((r) => r.zones === 0);
  if (p.tab === 'mine') rows = rows.filter((r) => r.ownerId === actor.id);
  if (p.zone) rows = rows.filter((r) => String(r.adNumber ?? '') === p.zone);
  if (p.owner) rows = rows.filter((r) => (p.owner === 'none' ? !r.ownerId : r.ownerId === p.owner));
  if (p.dollar) rows = rows.filter((r) => (p.dollar === 'none' ? r.zones === 0 : String(r.dollar) === p.dollar));
  if (p.tab === 'red' || p.tab === 'orange' || p.tab === 'watched') {
    rows = rows.filter((r) => { const a = alertMap.get(r.id); if (!a) return false; const w = !!a.watchedUntil && a.watchedUntil.getTime() > now; return p.tab === 'watched' ? w : !w && a.level === (p.tab === 'red' ? 'RED' : 'ORANGE'); });
  }
  // Супер админ: өчигдрийн ашгийн төлөв (шүүлтүүр, эрэмбэ)
  // Бүүстгүй барааны төлөв үргэлж хоосон — зөвхөн бүүсттэйг (бүх хүснэгтээр нэг удаа, кэштэй) бодно
  const prof = sa ? await boostedProfits() : new Map<number, DayProfit>();
  if (sa && p.status) rows = rows.filter((r) => prof.get(r.id)?.status === p.status);
  const ro = sa ? await ownerReorder() : new Map<number, ReorderInfo>();
  if (sa && p.tab === 'reorder') rows = rows.filter((r) => NEEDS.includes(ro.get(r.id)?.level as ReorderLevel));
  if (sa && p.tab === 'ordered') rows = rows.filter((r) => ro.get(r.id)?.order);
  const dir = p.dir === 'asc' ? 1 : -1;
  const key = p.sort ?? 'week';
  const val = (r: OutflowRow): number | string => {
    if (key === 'name') return r.name;
    if (key === 'avg') return r.avg;
    if (key === 'zones') return r.zones;
    if (key === 'profit') { const pr = prof.get(r.id); return pr?.target ? pr.orders / pr.target : -1e12; }
    if (key === 'cover') return -(ro.get(r.id)?.days ?? 1e9);
    if (/^d[0-6]$/.test(key)) return r.daily[Number(key[1])]!;
    return r.weekTotal;
  };
  rows = [...rows].sort((a, b) => { const x = val(a), y = val(b); return (typeof x === 'string' ? x.localeCompare(y as string) : (x as number) - (y as number)) * dir || a.name.localeCompare(b.name); });
  const total = rows.length;
  const page = Math.max(1, Math.min(Number(p.page) || 1, Math.max(1, Math.ceil(total / PAGE))));
  const slice = rows.slice((page - 1) * PAGE, page * PAGE).map((r) => ({ ...r }));
  const stock = await productStockTotals(slice.map((r) => r.id));
  for (const r of slice) {
    const s = stock.get(r.id); r.stock = { total: s?.total ?? 0, available: s?.available ?? 0, driver: s?.driver ?? 0 };
    const a = alertMap.get(r.id); r.alert = a && !(a.watchedUntil && a.watchedUntil.getTime() > now) ? a.level : null;
    r.alertInfo = a ? { level: a.level, reasons: a.reasons, pages: a.pages, watchedUntil: a.watchedUntil && a.watchedUntil.getTime() > now ? a.watchedUntil : null, watchedBy: a.watchedBy } : null;
    if (sa) { const pr = prof.get(r.id); r.profit = pr ? { status: pr.status, perUnit: pr.perUnit, orders: pr.orders, target: pr.target } : null; r.reorder = ro.get(r.id) ?? null; }
  }
  const all = await allRows();
  const watchedN = alerts.filter((a) => a.watchedUntil && a.watchedUntil.getTime() > now).length;
  const counts = {
    all: all.length, boost: all.filter((r) => r.zones > 0).length, noboost: all.filter((r) => r.zones === 0).length,
    red: alerts.filter((a) => a.level === 'RED' && !(a.watchedUntil && a.watchedUntil.getTime() > now)).length,
    orange: alerts.filter((a) => a.level === 'ORANGE' && !(a.watchedUntil && a.watchedUntil.getTime() > now)).length,
    watched: watchedN, pageShort: (await pageShortfall()).length,
    ...(sa ? { reorder: [...ro.values()].filter((x) => NEEDS.includes(x.level)).length, ordered: [...ro.values()].filter((x) => x.order).length } : {}),
  };
  const days = Array.from({ length: 7 }, (_, i) => addDays(ubDay(), -i));
  return {
    rows: slice, total, page, pages: Math.max(1, Math.ceil(total / PAGE)), days, counts,
    totals: { today: all.reduce((s, r) => s + r.daily[0]!, 0), yesterday: all.reduce((s, r) => s + r.daily[1]!, 0) },
    dollars: [...new Set(all.filter((r) => r.zones > 0).map((r) => r.dollar))].sort((a, b) => a - b),
    owners: await marketers(),
    isLead: isLead(actor), isSA: sa,
  };
}

/** Аудит #152 (хурд): өчигдрийн зорилт — бүүсттэй бүх бараагаар 60 сек кэш, зэрэг хүсэлтэд нэг л удаа */
let profCache: { at: number; key: string; map: Map<number, DayProfit> } | null = null;
let profInflight: { key: string; p: Promise<Map<number, DayProfit>> } | null = null;
async function boostedProfits(): Promise<Map<number, DayProfit>> {
  const k = ubDay();
  if (profCache && profCache.key === k && Date.now() - profCache.at < CACHE_MS) return profCache.map;
  if (profInflight && profInflight.key === k) return profInflight.p;
  const p = (async () => {
    const before = profCache;
    // Өчигдөр асаалттай байсан бараа = одоо асаалттай ∪ өчигдрийн эхнээс хойш бүүстээ өөрчилсөн (унтраасан ч орно)
    const ids = (await db.$queryRaw<{ id: number }[]>`
      SELECT "productId" AS id FROM "ProductMarketing" WHERE zones > 0
      UNION SELECT DISTINCT "productId" FROM "BoostEvent" WHERE at >= ${ubDayStart(addDays(k, -1))}`).map((x) => x.id);
    const map = await yesterdayProfits(ids);
    if (profCache === before) profCache = { at: Date.now(), key: k, map };
    return map;
  })();
  profInflight = { key: k, p };
  try { return await p; } finally { if (profInflight?.p === p) profInflight = null; }
}
async function yesterdayProfits(ids: number[]): Promise<Map<number, DayProfit>> {
  const out = new Map<number, DayProfit>();
  if (!ids.length) return out;
  const cfg = await getConfig();
  const y = addDays(ubDay(), -1);
  const [products, segs, aggs] = await Promise.all([
    db.product.findMany({ where: { id: { in: ids } }, select: { id: true, price: true, costPrice: true } }),
    boostSegments(ids, ubDayStart(y).getTime(), ubDayStart(ubDay()).getTime()),
    unitsByDay(y, y, ids),
  ]);
  const am = new Map(aggs.map((a) => [a.productId, a]));
  for (const p of products) out.set(p.id, profitOf(cfg, p, am.get(p.id), peakBoost(segs.get(p.id), ubDayStart(y).getTime(), ubDayStart(ubDay()).getTime()), y));
  return out;
}

/** Өнгө / хэмжээ бүрийн 7 хоногийн гарц (догол мөр) — гарцын дүрмээр, ☎ ба үлдэгдэлтэй */
export async function productVariants(actor: UserActor, productIdIn: unknown) {
  assertView(actor);
  const id = Number(productIdIn);
  const today = ubDay(); const from = addDays(today, -6);
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, -i));
  const [variants, rows, phones, stock] = await Promise.all([
    db.productVariant.findMany({ where: { productId: id }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], select: { id: true, code: true, color: true, size: true, isActive: true } }),
    db.$queryRaw<{ variantId: number; day: Date; qty: number }[]>`
      SELECT l."variantId", (o."confirmedAt" + interval '8 hours')::date AS day, sum(l.qty)::int AS qty
      FROM "Order" o JOIN "OrderLine" l ON l."orderId" = o.id
      WHERE o."confirmedAt" >= ${ubDayStart(from)} AND o."confirmedAt" < ${ubDayStart(addDays(today, 1))} AND ${COUNTED} AND l."productId" = ${id}
      GROUP BY 1, 2`,
    db.$queryRaw<{ variantId: number; day: Date; n: number }[]>`
      SELECT c."variantId", (c."createdAt" + interval '8 hours')::date AS day, count(DISTINCT c.phone)::int AS n
      FROM "CallNote" c JOIN "ProductVariant" v ON v.id = c."variantId" AND v."productId" = ${id}
      WHERE c."createdAt" >= ${ubDayStart(from)} AND c."createdAt" < ${ubDayStart(addDays(today, 1))}
      GROUP BY 1, 2`,
    productStockTotals([id]),
  ]);
  const di = new Map(days.map((d, i) => [d, i]));
  const by = new Map<number, number[]>(); const ph = new Map<number, number[]>();
  for (const r of rows) { const i = di.get(ymdOf(r.day)); if (i === undefined) continue; const a = by.get(r.variantId) ?? Array(7).fill(0); a[i] += r.qty; by.set(r.variantId, a); }
  for (const r of phones) { const i = di.get(ymdOf(r.day)); if (i === undefined) continue; const a = ph.get(r.variantId) ?? Array(7).fill(0); a[i] += r.n; ph.set(r.variantId, a); }
  const st = stock.get(id)?.byVariant;
  return {
    days,
    variants: variants.map((v) => {
      const daily = by.get(v.id) ?? Array(7).fill(0); const week = daily.reduce((s, n) => s + n, 0);
      return { id: v.id, code: v.code, label: [v.color, v.size].filter(Boolean).join(' / ') || v.code, isActive: v.isActive, daily, week,
        avg: Math.round((week / 7) * 10) / 10, phones: ph.get(v.id) ?? Array(7).fill(0), available: st?.get(v.id)?.available ?? 0 };
    }).filter((v) => v.isActive || v.week > 0).sort((a, b) => b.week - a.week),
  };
}

/** Нэр дээр: пэйж бүрийн сүүлийн 3 хоногийн гарц + үлдэгдэл */
export async function productPages(actor: UserActor, productIdIn: unknown) {
  assertView(actor);
  const id = Number(productIdIn);
  const days = [0, 1, 2].map((i) => addDays(ubDay(), -i));
  const pg = await pagesFor([id], days);
  const names = new Set<string>();
  for (const d of days) for (const x of pg.get(`${id}|${d}`) ?? []) names.add(x.name);
  const pages = [...names].map((name) => ({ name, days: days.map((d) => pg.get(`${id}|${d}`)?.find((x) => x.name === name)?.n ?? 0) }))
    .map((x) => ({ ...x, total: x.days.reduce((s, n) => s + n, 0) })).sort((a, b) => b.total - a.total);
  const s = (await productStockTotals([id])).get(id);
  return { days, pages, stock: { total: s?.total ?? 0, available: s?.available ?? 0, driver: s?.driver ?? 0 } };
}

// ───────────── Барааны маркетинг: бүүст, тэмдэглэл, хариуцагч ─────────────

async function marketers() {
  return db.user.findMany({ where: { isActive: true, roles: { hasSome: MKT } }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
}

/** $, Бүүст, AD — маркетинг бүгд бүх бараанд (хуучин шиг); өөрчлөлт бүр цагтай (BoostEvent) */
export async function saveBoost(actor: UserActor, b: { productId?: unknown; dollar?: unknown; zones?: unknown; adNumber?: unknown }) {
  assertView(actor);
  const productId = Number(b.productId);
  const p = await db.product.findUnique({ where: { id: productId }, select: { id: true, code: true, name: true } });
  if (!p) throw notFound('Бараа олдсонгүй');
  const cfg = await getConfig();
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(7400, ${productId}::int)`;
    const cur = await tx.productMarketing.findUnique({ where: { productId } });
    const dollar = b.dollar === undefined ? cur?.dollar ?? cfg.defaultDollar : cleanInt(b.dollar, '$', 1, 10_000);
    const zones = b.zones === undefined ? cur?.zones ?? 0 : cleanInt(b.zones, 'Бүүст', 0, 1000);
    const adNumber = b.adNumber === undefined ? cur?.adNumber ?? null : b.adNumber === '' || b.adNumber === null ? null : cleanInt(b.adNumber, 'AD', 0, 100000);
    if (cur && cur.dollar === dollar && cur.zones === zones && cur.adNumber === adNumber) return cur;
    const now = new Date();
    const boostOnAt = zones > 0 ? (cur?.zones ? cur.boostOnAt ?? now : now) : null;
    const r = await tx.productMarketing.upsert({
      where: { productId },
      create: { productId, dollar, zones, adNumber, boostOnAt, updatedByName: actor.name },
      update: { dollar, zones, adNumber, boostOnAt, updatedByName: actor.name },
    });
    await tx.boostEvent.create({ data: { productId, at: now, dollar, zones, adNumber, byId: actor.id, byName: actor.name } });
    const action = !cur?.zones && zones > 0 ? 'outflow.boost_on' : cur?.zones && zones === 0 ? 'outflow.boost_off' : 'outflow.boost';
    await writeAudit(actor, action, 'ProductMarketing', String(productId), { product: `${p.code} ${p.name}`, before: cur ? { dollar: cur.dollar, zones: cur.zones, adNumber: cur.adNumber } : null, after: { dollar, zones, adNumber } }, tx);
    return r;
  }, { timeout: 20_000, maxWait: 10_000 }).then((r) => {
    patchRows([productId], (x) => { x.dollar = r.dollar; x.zones = r.zones; x.adNumber = r.adNumber; });
    return r;
  }).finally(() => { alertCache = null; alertGen++; shortCache = null; shortGen++; profCache = null; }); // Аудит #152: хадгалсны ДАРАА цэвэрлэнэ; «Бараа татах» бүүстээс хамаарахгүй — хэвээр
}

export async function saveNote(actor: UserActor, b: { productId?: unknown; note?: unknown }) {
  assertView(actor);
  const productId = Number(b.productId);
  if (!(await db.product.findUnique({ where: { id: productId }, select: { id: true } }))) throw notFound('Бараа олдсонгүй');
  const note = cleanText(b.note, 500);
  await db.$transaction(async (tx) => {
    await tx.productMarketing.upsert({ where: { productId }, create: { productId, note, updatedByName: actor.name }, update: { note, updatedByName: actor.name } });
    await writeAudit(actor, 'outflow.note', 'ProductMarketing', String(productId), { note }, tx);
  });
  patchRows([productId], (x) => { x.note = note; });
  return { ok: true };
}

/** Хариуцагч оноох (нэг эсвэл бөөнөөр) — ахлах маркетинг, админ, СА; userId хоосон бол авна */
export async function setOwner(actor: UserActor, b: { productIds?: unknown; userId?: unknown }) {
  assertLead(actor);
  const ids = [...new Set((Array.isArray(b.productIds) ? b.productIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) throw badRequest('Бараа сонгоно уу');
  if (ids.length > 5000) throw badRequest('Хэт олон бараа');
  let user: { id: string; name: string } | null = null;
  if (b.userId) {
    user = await db.user.findFirst({ where: { id: String(b.userId), isActive: true, roles: { hasSome: MKT } }, select: { id: true, name: true } });
    if (!user) throw badRequest('Маркетинг ажилтан олдсонгүй');
  }
  const existing = await db.product.count({ where: { id: { in: ids } } });
  if (existing !== ids.length) throw badRequest('Зарим бараа олдсонгүй');
  const sorted = [...ids].sort((a, b) => a - b);
  await db.$transaction(async (tx) => {
    // Аудит #152: нэг хүсэлтээр (5,000 барааг ч хэдхэн мс) — мөрийг удаан түгжихгүй, зэрэг онооход deadlock гарахгүй
    await tx.$executeRaw`
      INSERT INTO "ProductMarketing" ("productId", "ownerId", "ownerName", "updatedByName", "updatedAt")
      SELECT x, ${user?.id ?? null}::uuid, ${user?.name ?? null}, ${actor.name}, now() FROM unnest(${sorted}::int[]) AS x
      ON CONFLICT ("productId") DO UPDATE SET "ownerId" = EXCLUDED."ownerId", "ownerName" = EXCLUDED."ownerName", "updatedByName" = EXCLUDED."updatedByName", "updatedAt" = now()`;
    await writeAudit(actor, 'outflow.owner', 'ProductMarketing', ids.length === 1 ? String(ids[0]) : null, { count: ids.length, owner: user?.name ?? null }, tx);
  }, { timeout: 60_000 });
  patchRows(ids, (x) => { x.ownerId = user?.id ?? null; x.ownerName = user?.name ?? null; });
  return { updated: ids.length };
}

/** Шүүсэн бүх барааны дугаар (бөөнөөр оноохдоо) */
export async function filteredIds(actor: UserActor, p: TableParams) {
  assertLead(actor);
  const r = await withHeavy(() => outflowTableIds(actor, p), { name: 'outflow-ids', max: 1 });
  return { ids: r };
}
async function outflowTableIds(actor: UserActor, p: TableParams) {
  const res = await outflowTable(actor, { ...p, page: 1 });
  if (res.total <= PAGE) return res.rows.map((r) => r.id);
  const pages = res.pages; const ids: number[] = res.rows.map((r) => r.id);
  for (let i = 2; i <= pages; i++) ids.push(...(await outflowTable(actor, { ...p, page: i })).rows.map((r) => r.id));
  return ids;
}

// ───────────── Пэйж хувиарлах, статистик ─────────────

export async function pageBoard(actor: UserActor) {
  assertView(actor);
  const [pages, mps, users] = await Promise.all([db.page.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }), db.marketingPage.findMany(), marketers()]);
  const m = new Map(mps.map((x) => [x.pageId, x]));
  return { pages: pages.map((p) => ({ id: p.id, name: p.name, userId: m.get(p.id)?.userId ?? null, userName: m.get(p.id)?.userName ?? null })), users, canEdit: isLead(actor) };
}

/** Нэг пэйж — нэг маркетинг */
export async function setPageOwner(actor: UserActor, b: { pageId?: unknown; userId?: unknown }) {
  assertLead(actor);
  const pageId = Number(b.pageId);
  const page = await db.page.findUnique({ where: { id: pageId } });
  if (!page) throw notFound('Пэйж олдсонгүй');
  await db.$transaction(async (tx) => {
    const old = await tx.marketingPage.findUnique({ where: { pageId } });
    if (!b.userId) { if (old) await tx.marketingPage.delete({ where: { pageId } }); }
    else {
      const u = await tx.user.findFirst({ where: { id: String(b.userId), isActive: true, roles: { hasSome: MKT } }, select: { id: true, name: true } });
      if (!u) throw badRequest('Маркетинг ажилтан олдсонгүй');
      await tx.marketingPage.upsert({ where: { pageId }, create: { pageId, userId: u.id, userName: u.name, updatedByName: actor.name }, update: { userId: u.id, userName: u.name, updatedByName: actor.name } });
    }
    await writeAudit(actor, 'outflow.page_owner', 'Page', String(pageId), { page: page.name, from: old?.userName ?? null, to: b.userId ? String(b.userId) : null }, tx);
  });
  return { ok: true };
}

/** Статистик — маркетинг бүрийн пэйжийн захиалга (гарцын дүрмээр), 1 пэйжийн дундаж; мөнгөн дүнгүй */
export async function stats(actor: UserActor, fromIn: unknown, toIn: unknown) {
  assertLead(actor);
  const from = isYmd(fromIn) ? fromIn : ubDay(); const to = isYmd(toIn) ? toIn : from;
  if (from > to) throw badRequest('Огноо буруу');
  if (Date.parse(to) - Date.parse(from) > 93 * 86_400_000) throw badRequest('Хамгийн ихдээ 93 хоног');
  const rows = await withHeavy(() => db.$queryRaw<{ userId: string; userName: string; pages: number; orders: number }[]>`
    SELECT mp."userId", max(mp."userName") AS "userName", count(DISTINCT mp."pageId")::int AS pages, count(DISTINCT o.id)::int AS orders
    FROM "MarketingPage" mp
    LEFT JOIN "Order" o ON o."pageId" = mp."pageId" AND o."confirmedAt" >= ${ubDayStart(from)} AND o."confirmedAt" < ${ubDayStart(addDays(to, 1))} AND ${COUNTED}
    GROUP BY 1 ORDER BY orders DESC`, { name: 'outflow-stats', max: 2 });
  return { from, to, rows: rows.map((r, i) => ({ ...r, rank: i + 1, perPage: r.pages ? Math.round(r.orders / r.pages) : 0 })), totals: { marketers: rows.length, pages: rows.reduce((s, r) => s + r.pages, 0), orders: rows.reduce((s, r) => s + r.orders, 0) } };
}

// ───────────── Ажлын цонх ─────────────

/** Идэвхтэй сонголтын явц: «Хийсэн» (N захиалга) эсвэл хугацаа дууссан (N хоног) */
let claimsAt = 0;
/** Аудит #152: хуудас нээх бүрт биш — 30 сек тутам (арын ажил ч дуудна) */
async function syncClaimsThrottled() { if (process.env.NODE_ENV !== 'test' && Date.now() - claimsAt < 30_000) return 0; claimsAt = Date.now(); return syncClaims(); }
export async function syncClaims() {
  const cfg = await getConfig();
  const active = await db.workClaim.findMany({ where: { status: 'ACTIVE' } });
  if (!active.length) return 0;
  // Захиалгыг хамгийн эртний идэвхтэй ажлын эхлэлээр хязгаарлана (өмнө нь бүх мөрийг уншдаг байсан — аудит №3). Үр дүн ижил.
  const claimLb = new Date(Math.min(...active.map((c) => c.claimedAt.getTime())));
  const prog = await db.$queryRaw<{ id: number; n: number }[]>`
    WITH c AS (SELECT id, "productId", "claimedAt" FROM "WorkClaim" WHERE status = 'ACTIVE'),
    x AS (SELECT l."productId", o.id, o."confirmedAt" FROM "Order" o JOIN "OrderLine" l ON l."orderId" = o.id
          WHERE o."confirmedAt" >= ${claimLb} AND ${LIVE} AND l."productId" IN (SELECT "productId" FROM c))
    SELECT c.id, count(DISTINCT x.id) FILTER (WHERE x."confirmedAt" >= c."claimedAt")::int AS n
    FROM c LEFT JOIN x ON x."productId" = c."productId" GROUP BY 1`;
  const pm = new Map(prog.map((r) => [r.id, r.n]));
  let changed = 0;
  for (const c of active) {
    const n = pm.get(c.id) ?? 0;
    if (n >= cfg.claimTarget) {
      await db.$transaction(async (tx) => {
        const u = await tx.workClaim.updateMany({ where: { id: c.id, status: 'ACTIVE' }, data: { status: 'COMPLETED', progress: n, endedAt: new Date(), endedByName: 'СИСТЕМ' } });
        if (!u.count) return;
        await tx.productMarketing.upsert({ where: { productId: c.productId }, create: { productId: c.productId, doneAt: new Date(), doneByName: c.userName },
          update: { doneAt: new Date(), doneByName: c.userName } });
        await writeAudit({ id: null, name: 'СИСТЕМ' }, 'outflow.claim_done', 'ProductMarketing', String(c.productId), { by: c.userName, orders: n }, tx);
      });
      changed++;
    } else if (Date.now() - c.claimedAt.getTime() > cfg.claimExpireDays * 86_400_000) {
      const u = await db.workClaim.updateMany({ where: { id: c.id, status: 'ACTIVE' }, data: { status: 'EXPIRED', progress: n, endedAt: new Date(), endedByName: 'СИСТЕМ' } });
      if (u.count) { await writeAudit({ id: null, name: 'СИСТЕМ' }, 'outflow.claim_expired', 'ProductMarketing', String(c.productId), { by: c.userName, days: cfg.claimExpireDays }); changed++; }
    } else if (n !== c.progress) await db.workClaim.update({ where: { id: c.id }, data: { progress: n } });
  }
  if (changed) bustTable();
  return changed;
}

/** Аудит #152 (хурд): сүүлийн 3 хоногт зарагдсан бараа — 30 сек кэш, зэрэг хүсэлтэд нэг л удаа */
let soldCache: { at: number; key: string; set: Set<number> } | null = null;
let soldInflight: { key: string; p: Promise<Set<number>> } | null = null;
async function soldRecently(from: string, to: string): Promise<Set<number>> {
  const k = `${from}|${to}`;
  if (process.env.NODE_ENV !== 'test' && soldCache && soldCache.key === k && Date.now() - soldCache.at < 30_000) return soldCache.set;
  if (soldInflight && soldInflight.key === k) return soldInflight.p;
  const p = unitsByDay(from, to).then((a) => new Set(a.filter((x) => x.qty > 0).map((x) => x.productId)));
  soldInflight = { key: k, p };
  try { const set = await p; soldCache = { at: Date.now(), key: k, set }; return set; } finally { if (soldInflight?.p === p) soldInflight = null; }
}
export async function workWindow(actor: UserActor, p: { tab?: string; q?: string; page?: number }) {
  assertView(actor);
  await syncClaimsThrottled();
  const cfg = await getConfig();
  const today = ubDay(); const from = addDays(today, -2);
  const q = cleanText(p.q, 60);
  const sold = await soldRecently(from, today);
  const where: Prisma.ProductWhereInput = { status: { not: 'ARCHIVED' }, ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { code: { contains: q, mode: 'insensitive' } }] } : {}) };
  let products = await db.product.findMany({ where, select: { id: true, code: true, name: true, price: true }, orderBy: { name: 'asc' } });
  if (p.tab !== 'all') products = products.filter((x) => !sold.has(x.id));
  const total = products.length; const per = 30;
  const page = Math.max(1, Math.min(Number(p.page) || 1, Math.max(1, Math.ceil(total / per))));
  const slice = products.slice((page - 1) * per, page * per);
  const ids = slice.map((x) => x.id);
  const [claims, pms, stock, mine, allActive] = await Promise.all([
    db.workClaim.findMany({ where: { productId: { in: ids }, status: 'ACTIVE' } }),
    db.productMarketing.findMany({ where: { productId: { in: ids } } }),
    productStockTotals(ids),
    db.workClaim.findMany({ where: { userId: actor.id, status: 'ACTIVE' }, orderBy: { claimedAt: 'desc' } }),
    isLead(actor) ? db.workClaim.findMany({ where: { status: 'ACTIVE' }, orderBy: [{ userName: 'asc' }, { claimedAt: 'desc' }] }) : Promise.resolve([]),
  ]);
  const cm = new Map(claims.map((c) => [c.productId, c])); const nm = new Map(pms.map((x) => [x.productId, x]));
  const names = new Map((await db.product.findMany({ where: { id: { in: [...mine, ...allActive].map((c) => c.productId) } }, select: { id: true, code: true, name: true } })).map((x) => [x.id, x]));
  const claimView = (c: (typeof mine)[number]) => ({ id: c.id, productId: c.productId, code: names.get(c.productId)?.code ?? '', name: names.get(c.productId)?.name ?? '', userId: c.userId, userName: c.userName, claimedAt: c.claimedAt, progress: c.progress,
    expiresAt: new Date(c.claimedAt.getTime() + cfg.claimExpireDays * 86_400_000) });
  return {
    tab: p.tab === 'all' ? 'all' : 'idle', total, page, pages: Math.max(1, Math.ceil(total / per)), target: cfg.claimTarget, expireDays: cfg.claimExpireDays,
    rows: slice.map((x) => { const c = cm.get(x.id); const s = stock.get(x.id); return { ...x, available: s?.available ?? 0, note: nm.get(x.id)?.note ?? '', doneAt: nm.get(x.id)?.doneAt ?? null,
      claim: c ? { id: c.id, userId: c.userId, userName: c.userName, progress: c.progress, mine: c.userId === actor.id } : null }; }),
    mine: mine.map(claimView), all: allActive.map(claimView), canManageAll: isLead(actor), me: actor.id,
  };
}

export async function claim(actor: UserActor, productIdIn: unknown) {
  assertView(actor);
  const productId = Number(productIdIn);
  const p = await db.product.findUnique({ where: { id: productId }, select: { code: true, name: true, status: true } });
  if (!p) throw notFound('Бараа олдсонгүй');
  // Аудит А11: архивласан барааг ажилд авахгүй
  if (p.status === 'ARCHIVED') throw badRequest('Архивласан барааг сонгох боломжгүй', 'archived');
  // Аудит #152: сүүлийн 3 хоногт зарагдаж буй барааг «ажилд авах»-гүй (ажлын цонх = зарагдаагүй бараа); ахлах нь болно
  if (!isLead(actor)) {
    const today = ubDay();
    if ((await unitsByDay(addDays(today, -2), today, [productId])).some((a) => a.qty > 0)) throw badRequest('Энэ бараа сүүлийн 3 хоногт зарагдаж байгаа — зарагдаагүй барааг л сонгоно', 'selling');
  }
  try {
    const c = await db.$transaction(async (tx) => {
      const c = await tx.workClaim.create({ data: { productId, userId: actor.id, userName: actor.name } });
      await writeAudit(actor, 'outflow.claim', 'ProductMarketing', String(productId), { product: `${p.code} ${p.name}` }, tx);
      return c;
    });
    return { id: c.id };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const o = await db.workClaim.findFirst({ where: { productId, status: 'ACTIVE' } });
      throw conflict(`Энэ барааг ${o?.userName ?? 'өөр хүн'} сонгосон байна`, 'claimed');
    }
    throw e;
  }
}

/** Өөрийнхөө — «Буцаах»; бусдынхыг — ахлах «Цуцлах» */
export async function release(actor: UserActor, claimIdIn: unknown) {
  assertView(actor);
  const c = await db.workClaim.findUnique({ where: { id: Number(claimIdIn) } });
  if (!c || c.status !== 'ACTIVE') throw notFound('Сонголт олдсонгүй');
  const own = c.userId === actor.id;
  if (!own && !isLead(actor)) throw forbidden('Бусдын сонголтыг ахлах маркетинг цуцална');
  await db.$transaction(async (tx) => {
    // Аудит А11: тэр мөчид «Дууссан» болсон бол дарж бичихгүй
    const u = await tx.workClaim.updateMany({ where: { id: c.id, status: 'ACTIVE' }, data: { status: own ? 'RETURNED' : 'CANCELLED', endedAt: new Date(), endedByName: actor.name } });
    if (!u.count) throw conflict('Сонголт аль хэдийн дууссан байна — хуудсаа шинэчилнэ үү', 'stale');
    await writeAudit(actor, own ? 'outflow.claim_returned' : 'outflow.claim_cancelled', 'ProductMarketing', String(c.productId), { by: c.userName }, tx);
  });
  return { ok: true };
}

// ───────────── Өөрийн ажил ─────────────

export async function myWork(actor: UserActor) {
  assertView(actor);
  await syncClaimsThrottled();
  const [pages, claims, owned] = await Promise.all([
    db.marketingPage.findMany({ where: { userId: actor.id } }),
    db.workClaim.findMany({ where: { userId: actor.id, status: 'ACTIVE' } }),
    db.productMarketing.findMany({ where: { ownerId: actor.id } }),
  ]);
  const ids = [...new Set([...claims.map((c) => c.productId), ...owned.map((o) => o.productId)])];
  const [products, pms, pageNames] = await Promise.all([
    db.product.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, name: true } }),
    db.productMarketing.findMany({ where: { productId: { in: ids } } }),
    db.page.findMany({ where: { id: { in: pages.map((p) => p.pageId) } }, select: { id: true, name: true } }),
  ]);
  const cfg = await getConfig();
  const pm = new Map(pms.map((x) => [x.productId, x])); const cl = new Set(claims.map((c) => c.productId));
  return {
    today: ubDay(), pages: pageNames.map((p) => p.name),
    products: products.map((p) => { const m = pm.get(p.id); return { id: p.id, code: p.code, name: p.name, claimed: cl.has(p.id), owned: m?.ownerId === actor.id,
      dollar: m?.dollar ?? cfg.defaultDollar, zones: m?.zones ?? 0, adNumber: m?.adNumber ?? null, boostOnAt: m?.boostOnAt ?? null }; }).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// ───────────── Үнэлгээ ─────────────

export type EvalClass = 'EXCELLENT' | 'GOOD' | 'AVERAGE' | 'POOR' | 'NO_BOOST';
const classify = (orders: number, expected: number): EvalClass =>
  expected <= 0 ? 'NO_BOOST' : orders >= 2 * expected ? 'EXCELLENT' : orders >= expected ? 'GOOD' : orders >= 0.5 * expected ? 'AVERAGE' : 'POOR';

/** Тухайн өдрийн маркетинг бүрийн бараа: хариуцсан + тэр өдөр бүүстийг нь өөрчилсөн */
async function evalProducts(date: string) {
  const d0 = ubDayStart(date).getTime(), d1 = ubDayStart(addDays(date, 1)).getTime();
  const [users, owned, evs] = await Promise.all([
    marketers(),
    db.productMarketing.findMany({ where: { ownerId: { not: null } }, select: { productId: true, ownerId: true } }),
    db.boostEvent.findMany({ where: { at: { gte: new Date(d0), lt: new Date(d1) }, byId: { not: null } }, select: { productId: true, byId: true, zones: true, at: true }, orderBy: { at: 'asc' } }),
  ]);
  const by = new Map<string, Set<number>>();
  for (const u of users) by.set(u.id, new Set());
  for (const o of owned) by.get(o.ownerId!)?.add(o.productId);
  // Аудит #152 (эзний шийдвэр «хариуцагчид л»): хариуцагчтай барааг зөвхөн хариуцагчид; хариуцагчгүй бол тэр өдөр бүүстийг АСААСАН хүнд.
  // Бусдын барааны дугаар / $ зассанаар өөртөө тооцуулахгүй.
  const ownedIds = new Set(owned.map((o) => o.productId));
  const evIds = [...new Set(evs.map((e) => e.productId))].filter((x) => !ownedIds.has(x));
  if (evIds.length) {
    const before = await db.$queryRaw<{ productId: number; zones: number }[]>`
      SELECT DISTINCT ON ("productId") "productId", zones FROM "BoostEvent" WHERE "productId" = ANY(${evIds}::int[]) AND at < ${new Date(d0)} ORDER BY "productId", at DESC`;
    const st = new Map(before.map((b) => [b.productId, b.zones]));
    for (const e of evs) {
      if (ownedIds.has(e.productId)) continue;
      const prevZones = st.get(e.productId) ?? 0;
      if (prevZones === 0 && e.zones > 0) by.get(e.byId!)?.add(e.productId);
      st.set(e.productId, e.zones);
    }
  }
  const ids = [...new Set([...by.values()].flatMap((s) => [...s]))];
  return { users, by, ids, d0, d1 };
}

export async function evaluation(actor: UserActor, dateIn: unknown) {
  assertView(actor);
  const date = isYmd(dateIn) ? dateIn : addDays(ubDay(), -1);
  const { users, by, ids, d0, d1 } = await evalProducts(date);
  const [segs, aggs, products, scores, mpages] = await Promise.all([
    boostSegments(ids, d0, d1), unitsByDay(date, date, ids),
    db.product.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, name: true } }),
    db.marketingScore.findMany({ where: { date: dateOnly(date) } }),
    db.marketingPage.groupBy({ by: ['userId'], _count: true }),
  ]);
  const pn = new Map(products.map((p) => [p.id, p])); const am = new Map(aggs.map((a) => [a.productId, a]));
  const sm = new Map(scores.map((s) => [s.userId, s])); const pc = new Map(mpages.map((x) => [x.userId, x._count]));
  const lead = isLead(actor);
  const rows = users.filter((u) => lead || u.id === actor.id).map((u) => {
    const items = [...(by.get(u.id) ?? [])].map((pid) => {
      const pk = peakBoost(segs.get(pid), d0, d1);
      const orders = am.get(pid)?.orders ?? 0; // #117: захиалгаар (бөөний нэг захиалга = 1)
      const expected = pk ? pk.zones * (pk.dollar || 5) : 0;
      return { productId: pid, code: pn.get(pid)?.code ?? '', name: pn.get(pid)?.name ?? '', dollar: pk?.dollar ?? null, zones: pk?.zones ?? 0, expected, orders, cls: classify(orders, expected) };
    }).filter((x) => x.zones > 0 || x.orders > 0).sort((a, b) => b.orders - a.orders);
    const s = sm.get(u.id);
    return {
      userId: u.id, name: u.name, pages: pc.get(u.id) ?? 0, items,
      boostCount: items.reduce((x, i) => x + i.zones, 0), orderCount: items.reduce((x, i) => x + i.orders, 0),
      excellent: items.filter((i) => i.cls === 'EXCELLENT').length, good: items.filter((i) => i.cls === 'GOOD').length, poor: items.filter((i) => i.cls === 'POOR').length,
      score: s ? { score: s.score, salaryAmount: s.salaryAmount, note: s.note, scoredByName: s.scoredByName, updatedAt: s.updatedAt } : null,
      canScore: isSA(actor) && u.id !== actor.id,
    };
  }).sort((a, b) => b.orderCount - a.orderCount);
  return { date, rows, canScore: isSA(actor) };
}

/** Өдрийн дэлгэрэнгүй — сонгосон өдрөөс 7 хоног (хуучин алдааг зассан: өнөөдрөөс биш) */
export async function dailyDetail(actor: UserActor, dateIn: unknown) {
  assertView(actor);
  const date = isYmd(dateIn) ? dateIn : ubDay();
  const { users, by, ids, d0, d1 } = await evalProducts(date);
  const from = addDays(date, -6);
  const [segs, aggs, products, stock] = await Promise.all([
    boostSegments(ids, d0, d1), unitsByDay(from, date, ids),
    db.product.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, name: true } }),
    productStockTotals(ids),
  ]);
  const days = Array.from({ length: 7 }, (_, i) => addDays(date, -i));
  const am = new Map(aggs.map((a) => [`${a.productId}|${a.day}`, a.qty]));
  const pn = new Map(products.map((p) => [p.id, p])); const pms = new Map((await db.productMarketing.findMany({ where: { productId: { in: ids } } })).map((x) => [x.productId, x]));
  const lead = isLead(actor);
  const rows = users.filter((u) => lead || u.id === actor.id).map((u) => {
    const items = [...(by.get(u.id) ?? [])].map((pid) => {
      const pk = peakBoost(segs.get(pid), d0, d1);
      const daily = days.map((d) => am.get(`${pid}|${d}`) ?? 0);
      return { productId: pid, code: pn.get(pid)?.code ?? '', name: pn.get(pid)?.name ?? '', dollar: pk?.dollar ?? null, zones: pk?.zones ?? 0, adNumber: pms.get(pid)?.adNumber ?? null,
        available: stock.get(pid)?.available ?? 0, daily, week: daily.reduce((s, n) => s + n, 0) };
    }).filter((x) => x.zones > 0 || x.week > 0);
    return { userId: u.id, name: u.name, items, dollars: items.reduce((s, i) => s + (i.dollar ?? 0) * i.zones, 0), zones: items.reduce((s, i) => s + i.zones, 0), ads: items.filter((i) => i.adNumber !== null).length, week: items.reduce((s, i) => s + i.week, 0) };
  }).sort((a, b) => b.week - a.week).map((r, i) => ({ ...r, rank: i + 1 }));
  return { date, days, rows };
}

/** Оноо, цалин, тэмдэглэл — ахлах маркетинг, админ, СА; өөрийгөө үнэлэхгүй. Цалин «Ажилтны цалин»-д автоматаар орно */
export async function saveScore(actor: UserActor, b: { userId?: unknown; date?: unknown; score?: unknown; salaryAmount?: unknown; note?: unknown }) {
  // Аудит #152 (эзний шийдвэр): үнэлгээ (ба үнэлгээний цалин)-г ЗӨВХӨН Супер админ тавина
  if (!isSA(actor)) throw forbidden('Үнэлгээг зөвхөн Супер админ тавина');
  const userId = String(b.userId ?? '');
  if (userId === actor.id) throw forbidden('Өөрийгөө үнэлэхгүй');
  if (!isYmd(b.date)) throw badRequest('Огноо буруу');
  const date = b.date;
  // Аудит А11: ирээдүйн өдрийг үнэлэхгүй
  if (date > ubDay()) throw badRequest('Ирээдүйн өдрийг үнэлэх боломжгүй', 'future_date');
  const u = await db.user.findFirst({ where: { id: userId, roles: { hasSome: MKT } }, select: { id: true, name: true } });
  if (!u) throw badRequest('Маркетинг ажилтан олдсонгүй');
  const score = b.score === '' || b.score === null || b.score === undefined ? null : cleanInt(b.score, 'Оноо (1–10)', 1, 10);
  const salaryAmount = cleanInt(b.salaryAmount, 'Цалин', 0, 100_000_000);
  const note = cleanText(b.note, 500);
  const ev = await evaluation({ ...actor }, date);
  const row = ev.rows.find((r) => r.userId === userId);
  const locked = await db.staffSalaryRecord.findFirst({ where: { userId, isLocked: true, periodStart: { lte: dateOnly(date) }, periodEnd: { gte: dateOnly(date) } }, select: { periodLabel: true, transferred: true } });
  // Аудит #152: цоожилсон / шилжүүлсэн цалингийн хугацааны үнэлгээг өөрчлөхгүй (түүх ба олгосон цалин зөрөхгүй)
  if (locked) throw conflict(`${locked.periodLabel}-ны цалин ${locked.transferred ? 'шилжүүлсэн' : 'цоожтой'} — энэ өдрийн үнэлгээг өөрчлөх боломжгүй${locked.transferred ? '' : ' (нягтлан цоож тайлсны дараа)'}`, 'salary_locked');
  await db.$transaction(async (tx) => {
    const old = await tx.marketingScore.findUnique({ where: { userId_date: { userId, date: dateOnly(date) } } });
    await tx.marketingScore.upsert({
      where: { userId_date: { userId, date: dateOnly(date) } },
      create: { userId, userName: u.name, date: dateOnly(date), score, salaryAmount, note, boostCount: row?.boostCount ?? 0, orderCount: row?.orderCount ?? 0, scoredById: actor.id, scoredByName: actor.name },
      update: { score, salaryAmount, note, boostCount: row?.boostCount ?? 0, orderCount: row?.orderCount ?? 0, scoredById: actor.id, scoredByName: actor.name },
    });
    await writeAudit(actor, 'outflow.score', 'User', userId, { name: u.name, date, before: old ? { score: old.score, salaryAmount: old.salaryAmount } : null, after: { score, salaryAmount } }, tx, ['money']);
  });
  return { ok: true, warning: null as string | null };
}

export async function scoreHistory(actor: UserActor, fromIn: unknown, toIn: unknown) {
  assertView(actor);
  const to = isYmd(toIn) ? toIn : ubDay(); const from = isYmd(fromIn) ? fromIn : `${to.slice(0, 7)}-01`;
  if (from > to) throw badRequest('Огноо буруу');
  const rows = await db.marketingScore.groupBy({ by: ['userId', 'userName'], where: { date: { gte: dateOnly(from), lte: dateOnly(to) }, ...(isLead(actor) ? {} : { userId: actor.id }) },
    _sum: { salaryAmount: true, boostCount: true, orderCount: true }, _avg: { score: true }, _count: true });
  return { from, to, rows: rows.map((r) => ({ userId: r.userId, name: r.userName, days: r._count, salary: r._sum.salaryAmount ?? 0, boostCount: r._sum.boostCount ?? 0, orderCount: r._sum.orderCount ?? 0,
    avgScore: r._avg.score === null ? null : Math.round(r._avg.score * 10) / 10 })).sort((a, b) => b.orderCount - a.orderCount) };
}

/** «Ажилтны цалин»-д: тухайн хугацааны үнэлгээний цалингийн нийлбэр */
export async function evaluationSalary(tx: Tx | typeof db, userId: string, start: string, end: string) {
  const a = await tx.marketingScore.aggregate({ where: { userId, date: { gte: dateOnly(start), lte: dateOnly(end) } }, _sum: { salaryAmount: true } });
  return a._sum.salaryAmount ?? 0;
}

// ───────────── Ашгийн задаргаа (зөвхөн Супер админ) ─────────────

export async function profitDetail(actor: UserActor, productIdIn: unknown) {
  assertSA(actor);
  const id = Number(productIdIn);
  const p = await db.product.findUnique({ where: { id }, select: { id: true, code: true, name: true, price: true, costPrice: true } });
  if (!p) throw notFound('Бараа олдсонгүй');
  const cfg = await getConfig();
  const today = ubDay(); const from = addDays(today, -7);
  const now = Date.now();
  const [segs, aggs, pm] = await Promise.all([boostSegments([id], ubDayStart(from).getTime(), now), unitsByDay(from, today, [id]), db.productMarketing.findUnique({ where: { productId: id } })]);
  const am = new Map(aggs.map((a) => [a.day, a]));
  const days = Array.from({ length: 8 }, (_, i) => addDays(today, -i)).map((d) => {
    const s = ubDayStart(d).getTime(); const e = Math.min(ubDayStart(addDays(d, 1)).getTime(), now);
    return profitOf(cfg, p, am.get(d), peakBoost(segs.get(id), s, e), d);
  });
  const unitCost = p.costPrice ?? Math.round((p.price * cfg.costPct) / 100);
  const margin = p.price - unitCost - cfg.oppCost - cfg.deliveryCost;
  const zones = pm?.zones ?? 0, dollar = pm?.dollar ?? cfg.defaultDollar;
  return {
    product: { id: p.id, code: p.code, name: p.name, price: p.price, costPrice: p.costPrice, unitCost, costEstimated: p.costPrice === null },
    cfg: { oppCost: cfg.oppCost, deliveryCost: cfg.deliveryCost, rate: cfg.rate, costPct: cfg.costPct },
    boost: { dollar, zones, target: zones * dollar, dailySpend: zones * dollar * cfg.rate, boostOnAt: pm?.boostOnAt ?? null },
    marginBeforeBoost: margin,
    /** Бүүсттэй захиалгын ашиг = бүүстгүй ашиг − 1$ (#153) */
    perOrder: margin - cfg.rate,
    days,
  };
}

// ───────────── Бараа татах — нөөц хоног (#119, зөвхөн Супер админ) ─────────────
/**
 * Нөөц хоног = боломжтой үлдэгдэл ÷ өдрийн хурд. Хурд (бөөний захиалгагүй) = дараах гурвын ИХ нь:
 *   сүүлийн 7 бүтэн өдрийн дундаж, сүүлийн 3 бүтэн өдрийн дундаж, өнөөдөр одоог хүртэл.
 *   Шинэ бараа (7 хоногийн эхэнд зарагдаагүй өдрүүд) — анх зарагдсан өдрөөс тоолно.
 * ≤ urgentDays → 🔴 «яаралтай татах», ≤ leadDays (Хятадаас ирэх 15 хоног) → 🟠 «бараа татах».
 * «Захиалсан» дармагц сануулга 🚚 болно; агуулахад орлого (RECEIPT) ормогц автоматаар хаагдаж, шинэ үлдэгдлээр дахин эхэлнэ;
 * ирэх өдөр өнгөрөөд ирээгүй бол 🔴 «Хоцорсон». Барааны үлдэгдэлд хүрэхгүй (зөвхөн уншина).
 */
export type ReorderLevel = 'OK' | 'ORDER' | 'URGENT' | 'ORDERED' | 'LATE';
const NEEDS: ReorderLevel[] = ['ORDER', 'URGENT', 'LATE'];
export interface ReorderInfo {
  productId: number; available: number; pace: number; days: number | null; runOutDay: string | null; level: ReorderLevel;
  /** Нийлүүлэгчийн дэлгүүрт оноогдсон бол тэр дэлгүүр (#120) */
  shopId: number | null;
  basis: { avg7: number; avg3: number; today: number; fullDays: number };
  order: { id: number; qty: number; expectedDay: string; orderedAt: Date; byName: string; note: string; variantId: number | null } | null;
  /** Хамгийн яаралтай өнгө / хэмжээ (#128) — олон өнгөтэй бол */
  worstLabel: string | null;
  /** Өнгө / хэмжээ тус бүрийн нөөц ба «Захиалсан» (#128) */
  variants: VariantCover[];
  /** Нийлүүлэгчийн өөрийн «Захиалсан» тэмдэг ба төлөв (#124-Ж — таных тусдаа) */
  sup: { level: ReorderLevel; order: ReorderInfo['order']; days: number | null; worstLabel: string | null };
}
export interface VariantCover {
  variantId: number; label: string; available: number; pace: number; days: number | null; runOutDay: string | null;
  level: ReorderLevel; order: ReorderInfo['order']; supLevel: ReorderLevel; supOrder: ReorderInfo['order'];
}
export type ReorderScope = 'OWNER' | 'SUPPLIER';
let reorderCache: { at: number; map: Map<number, ReorderInfo> } | null = null;
/** Кэш хүчингүй болох бүрт нэмэгдэнэ — өмнө эхэлсэн тооцоо хуучин үр дүнгээ кэшлэхгүй */
let reorderGen = 0;
let reorderInflight: { gen: number; p: Promise<Map<number, ReorderInfo>> } | null = null;
function bustReorder() { reorderCache = null; reorderGen++; }
const REORDER_FRESH_MS = 60_000;
const REORDER_STALE_MS = 10 * 60_000;
/** Супер админы «Бараа татах»: тохиргоогоор нийлүүлэгчийн барааг хасна */
async function ownerReorder(): Promise<Map<number, ReorderInfo>> {
  const [m, cfg] = await Promise.all([computeReorder(), getConfig()]);
  if (!cfg.hideSupplierReorder) return m;
  return new Map([...m].filter(([, x]) => x.shopId === null));
}
const r1 = (n: number) => Math.round(n * 10) / 10;
function groupBy<T, K>(xs: T[], key: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of xs) { const k = key(x); const a = m.get(k); if (a) a.push(x); else m.set(k, [x]); }
  return m;
}

/**
 * Аудит №3: тооцоо ар талд (арын ажил минут тутам) шинэчлэгдэнэ; хуудас нээхэд бэлэн кэшийг уншина.
 * Кэш 1 минутаас хуучирсан (10 мин дотор) бол хуучнаа шууд буцааж, ар талд нэг л удаа шинэчилнэ (зэрэг хүсэлтүүд давхар бодохгүй).
 */
export async function computeReorder(fresh = false): Promise<Map<number, ReorderInfo>> {
  const c = reorderCache;
  if (!fresh && c) {
    const age = Date.now() - c.at;
    if (age < REORDER_FRESH_MS) return c.map;
    if (age < REORDER_STALE_MS) { refreshReorder().catch((e) => console.error('[reorder]', (e as Error).message)); return c.map; }
  }
  return refreshReorder();
}
function refreshReorder(): Promise<Map<number, ReorderInfo>> {
  if (reorderInflight && reorderInflight.gen === reorderGen) return reorderInflight.p;
  const gen = reorderGen;
  const p = computeReorderNow(gen).finally(() => { if (reorderInflight?.p === p) reorderInflight = null; });
  reorderInflight = { gen, p };
  return p;
}
/** Арын ажил: кэшийг дулаан байлгана */
export async function warmReorder() { await refreshReorder(); }

async function computeReorderNow(gen: number): Promise<Map<number, ReorderInfo>> {
  const cfg = await getConfig();
  const today = ubDay();
  const full = Array.from({ length: 7 }, (_, i) => addDays(today, -7 + i)); // хуучнаас шинэ рүү, өчигдөр хүртэл
  let orders = await db.reorderOrder.findMany({ where: { receivedAt: null, cancelledAt: null } });
  // Агуулахад орлого орсон бол «Захиалсан» хаагдана — өнгө тус бүрээр бол тэр өнгөний орлогоор (#128), бүхэлд нь бол аль ч өнгөний орлогоор
  if (orders.length) {
    const since = new Date(Math.min(...orders.map((o) => o.orderedAt.getTime())));
    const rec = await db.$queryRaw<{ productId: number; variantId: number; at: Date }[]>`
      SELECT v."productId", m."variantId", max(m.at) AS at FROM "StockMove" m JOIN "ProductVariant" v ON v.id = m."variantId"
      WHERE m.type = 'RECEIPT' AND m.at > ${since} AND v."productId" IN (${Prisma.join([...new Set(orders.map((o) => o.productId))])}) GROUP BY 1, 2`;
    const recBy = groupBy(rec, (r) => r.productId);
    const recAt = (o: (typeof orders)[number]) => {
      const xs = (recBy.get(o.productId) ?? []).filter((r) => (o.variantId === null || r.variantId === o.variantId) && r.at > o.orderedAt);
      return xs.length ? new Date(Math.max(...xs.map((r) => r.at.getTime()))) : null;
    };
    const done = orders.map((o) => ({ o, at: recAt(o) })).filter((x) => x.at);
    for (const { o, at } of done) await db.reorderOrder.updateMany({ where: { id: o.id, receivedAt: null }, data: { receivedAt: at! } });
    if (done.length) { const ids = new Set(done.map((x) => x.o.id)); orders = orders.filter((o) => !ids.has(o.id)); }
  }
  // Өнгө / хэмжээ тус бүрийн гарц (бөөний захиалгагүй — захиалга × барааны нийт ширхэг < bulkMin)
  const vrows = await db.$queryRaw<{ productId: number; variantId: number; day: Date; qty: number }[]>`
    SELECT x."productId", x."variantId", x.day, sum(x.q)::int AS qty FROM (
      SELECT l."productId", l."variantId", o.id, (o."confirmedAt" + interval '8 hours')::date AS day, sum(l.qty) AS q,
             sum(sum(l.qty)) OVER (PARTITION BY o.id, l."productId") AS pq
      FROM "Order" o JOIN "OrderLine" l ON l."orderId" = o.id
      WHERE o."confirmedAt" >= ${ubDayStart(full[0]!)} AND o."confirmedAt" < ${ubDayStart(addDays(today, 1))} AND ${COUNTED}
      GROUP BY 1, 2, 3, 4) x
    WHERE x.pq < ${cfg.bulkMin} GROUP BY 1, 2, 3`;
  // Хувилбар бүрийн өдрийн ширхэг: [7 бүтэн өдөр (хуучнаас), өнөөдөр] — массиваар (өмнө нь «id|өдөр» тэмдэгт түлхүүр, аудит №3)
  const dayIdx = new Map<string, number>(full.map((d, i) => [d, i])); dayIdx.set(today, 7);
  const vday = new Map<number, number[]>();
  for (const r of vrows) {
    const i = dayIdx.get(ymdOf(r.day)); if (i === undefined) continue;
    let a = vday.get(r.variantId); if (!a) { a = [0, 0, 0, 0, 0, 0, 0, 0]; vday.set(r.variantId, a); }
    a[i] = a[i]! + r.qty;
  }
  const ZERO = [0, 0, 0, 0, 0, 0, 0, 0];
  const ids = [...new Set([...vrows.filter((r) => r.qty > 0).map((r) => r.productId), ...orders.map((o) => o.productId)])];
  const [stock, variants] = await Promise.all([
    productStockTotals(ids),
    ids.length ? db.productVariant.findMany({ where: { productId: { in: ids } }, select: { id: true, productId: true, code: true, color: true, size: true, isActive: true }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }) : Promise.resolve([]),
  ]);
  const sp = ids.length ? await db.supplierProduct.findMany({ where: { productId: { in: ids }, OR: [{ toDate: null }, { toDate: { gt: dateOnly(today) } }] }, select: { productId: true, shopId: true } }) : [];
  const shopOf = new Map(sp.map((x) => [x.productId, x.shopId]));
  const paceOf = (a: number[]) => {
    const v = a.slice(0, 7);
    const first = v.findIndex((n) => n > 0);
    const fullDays = first < 0 ? 0 : 7 - first;
    const avg7 = fullDays ? v.slice(first).reduce((s, n) => s + n, 0) / fullDays : 0;
    const k3 = Math.min(3, fullDays);
    const avg3 = k3 ? v.slice(-k3).reduce((s, n) => s + n, 0) / k3 : 0;
    const td = a[7]!;
    return { pace: Math.max(avg7, avg3, td), avg7, avg3, td, fullDays };
  };
  type O = (typeof orders)[number];
  const view = (o: O | undefined) => o ? { id: o.id, qty: o.qty, expectedDay: o.expectedDay, orderedAt: o.orderedAt, byName: o.byName, note: o.note, variantId: o.variantId } : null;
  const levelOf = (o: O | undefined, days: number | null): ReorderLevel => o ? (o.expectedDay < today ? 'LATE' : 'ORDERED')
    : days !== null && days <= cfg.urgentDays ? 'URGENT' : days !== null && days <= cfg.leadDays ? 'ORDER' : 'OK';
  const RANK: Record<ReorderLevel, number> = { URGENT: 5, LATE: 4, ORDER: 3, ORDERED: 2, OK: 1 };
  const map = new Map<number, ReorderInfo>();
  // Бараа бүрээр урьдчилан бүлэглэнэ (өмнө нь бараа бүрт бүх хувилбар / захиалгыг шүүдэг байсан — 7 мянган бараанд 3.7 сек, аудит №3)
  const varBy = groupBy(variants, (v) => v.productId);
  const ordBy = groupBy(orders, (o) => o.productId);
  for (const id of ids) {
    const vs = varBy.get(id) ?? [];
    const byV = stock.get(id)?.byVariant;
    const pord = ordBy.get(id) ?? [];
    const mine = (scope: 'OWNER' | 'SUPPLIER') => pord.filter((o) => (o.scope === 'SUPPLIER') === (scope === 'SUPPLIER'));
    const whole = (scope: 'OWNER' | 'SUPPLIER') => mine(scope).find((o) => o.variantId === null);
    const vcov: VariantCover[] = vs.map((v) => {
      const p = paceOf(vday.get(v.id) ?? ZERO);
      const available = byV?.get(v.id)?.available ?? 0;
      const days = p.pace > 0 ? Math.max(0, Math.floor(available / p.pace)) : null;
      const vo = (scope: 'OWNER' | 'SUPPLIER') => mine(scope).find((o) => o.variantId === v.id) ?? whole(scope);
      return { variantId: v.id, label: [v.color, v.size].filter(Boolean).join(' / ') || v.code, available, pace: r1(p.pace), days, runOutDay: days === null ? null : addDays(today, days),
        level: levelOf(vo('OWNER'), days), order: view(vo('OWNER')), supLevel: levelOf(vo('SUPPLIER'), days), supOrder: view(vo('SUPPLIER')) };
    }).filter((v) => v.days !== null || v.order || v.supOrder);
    // Бараа бүхэлдээ (нийлбэр) — тайлбарт
    const tp = paceOf(ZERO.map((_, i) => vs.reduce((s, v) => s + (vday.get(v.id) ?? ZERO)[i]!, 0)));
    const available = stock.get(id)?.available ?? 0;
    const tdays = tp.pace > 0 ? Math.max(0, Math.floor(available / tp.pace)) : null;
    // Үндсэн мөр = хамгийн яаралтай өнгө (#128): нэг өнгө дуусахад л сануулна
    const worst = (scope: 'OWNER' | 'SUPPLIER', lv: (v: VariantCover) => ReorderLevel, od: (v: VariantCover) => VariantCover['order']) => {
      if (!vcov.length) { const o = whole(scope); return { level: levelOf(o, tdays), days: tdays, order: view(o), label: null as string | null }; }
      const w = [...vcov].sort((a, b) => RANK[lv(b)] - RANK[lv(a)] || (a.days ?? 1e9) - (b.days ?? 1e9))[0]!;
      return { level: lv(w), days: w.days, order: od(w), label: vcov.length > 1 ? w.label : null };
    };
    const ow = worst('OWNER', (v) => v.level, (v) => v.order);
    const sw = worst('SUPPLIER', (v) => v.supLevel, (v) => v.supOrder);
    map.set(id, {
      productId: id, shopId: shopOf.get(id) ?? null, available, pace: r1(tp.pace), days: ow.days, runOutDay: ow.days === null ? null : addDays(today, ow.days), level: ow.level,
      basis: { avg7: r1(tp.avg7), avg3: r1(tp.avg3), today: tp.td, fullDays: tp.fullDays },
      order: ow.order, worstLabel: ow.label, variants: vcov,
      sup: { level: sw.level, order: sw.order, days: sw.days, worstLabel: sw.label },
    });
  }
  if (gen === reorderGen) reorderCache = { at: Date.now(), map };
  return map;
}

/** Бүх хуудасны дээрх сануулга — зөвхөн Супер админд */
export async function reorderBanner(roles: Role[]): Promise<{ urgent: number; order: number; late: number } | null> {
  if (!roles.includes('SUPER_ADMIN')) return null;
  const m = await ownerReorder();
  let urgent = 0, order = 0, late = 0;
  for (const x of m.values()) { if (x.level === 'URGENT') urgent++; else if (x.level === 'ORDER') order++; else if (x.level === 'LATE') late++; }
  return urgent || order || late ? { urgent, order, late } : null;
}

/** «Захиалсан» — хэдэн ширхэг, хэзээ ирэх (анх: өнөөдөр + ирэх хоног) */
export async function markReordered(actor: UserActor, b: { productId?: unknown; variantId?: unknown; qty?: unknown; expectedDay?: unknown; note?: unknown }) {
  assertSA(actor);
  return createReorder(actor, b);
}
/** Эрх шалгасны дараа (СА эсвэл тухайн барааны нийлүүлэгч) */
export async function createReorder(actor: UserActor, b: { productId?: unknown; variantId?: unknown; qty?: unknown; expectedDay?: unknown; note?: unknown }, scope: ReorderScope = 'OWNER', shopId: number | null = null) {
  const productId = Number(b.productId);
  const product = Number.isInteger(productId) ? await db.product.findUnique({ where: { id: productId }, select: { id: true, name: true } }) : null;
  if (!product) throw notFound('Бараа олдсонгүй');
  const qty = cleanInt(b.qty, 'Захиалсан ширхэг', 1, 1_000_000);
  const cfg = await getConfig();
  const expectedDay = b.expectedDay ? String(b.expectedDay) : addDays(ubDay(), cfg.leadDays);
  if (!isYmd(expectedDay)) throw badRequest('Ирэх өдөр буруу');
  // Аудит #152: ирэх өдөр өнөөдрөөс 180 хоногийн дотор
  if (expectedDay < ubDay() || expectedDay > addDays(ubDay(), 180)) throw badRequest('Ирэх өдөр өнөөдрөөс 180 хоногийн дотор байна', 'bad_date');
  const note = cleanText(b.note, 300);
  // Өнгө / хэмжээ тус бүрээр (#128): тэр өнгийг захиалахад бусад өнгөний нөөц үргэлжлэн бодогдоно
  let variantId: number | null = null;
  let label = '';
  if (b.variantId !== undefined && b.variantId !== null && b.variantId !== '') {
    variantId = Number(b.variantId);
    const v = Number.isInteger(variantId) ? await db.productVariant.findUnique({ where: { id: variantId }, select: { productId: true, color: true, size: true, code: true } }) : null;
    if (!v || v.productId !== productId) throw badRequest('Өнгө / хэмжээ буруу');
    label = [v.color, v.size].filter(Boolean).join(' / ') || v.code;
  }
  const row = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(7401, ${productId}::int)`; // Аудит #152: зэрэг дарахад 500 биш
    const cur = await tx.reorderOrder.findFirst({ where: { productId, scope, variantId, receivedAt: null, cancelledAt: null } });
    if (cur) throw conflict(variantId ? `«${label}» аль хэдийн «Захиалсан» байна — эхлээд цуцална уу` : 'Энэ бараа аль хэдийн «Захиалсан» байна — эхлээд цуцална уу');
    if (!variantId && (await tx.reorderOrder.count({ where: { productId, scope, variantId: { not: null }, receivedAt: null, cancelledAt: null } }))) throw conflict('Өнгө тус бүрээр захиалсан байна — өнгө бүрээр нь тэмдэглэнэ үү');
    const r = await tx.reorderOrder.create({ data: { productId, variantId, qty, expectedDay, note, byName: actor.name, scope, shopId } });
    await writeAudit(actor, 'outflow.reorder', 'ReorderOrder', String(r.id), { productId, name: product.name, variant: label || null, qty, expectedDay, note, scope }, tx);
    return r;
  });
  bustReorder();
  return row;
}

/** «Захиалсан»-ыг цуцлах (андуурсан) — сануулга дахин гарна */
export async function cancelReorder(actor: UserActor, idIn: unknown) {
  assertSA(actor);
  return cancelReorderOf(actor, idIn);
}
export async function cancelReorderOf(actor: UserActor, idIn: unknown, productIds?: Set<number>, scope: ReorderScope = 'OWNER', shopId: number | null = null) {
  const id = Number(idIn);
  const cur = Number.isInteger(id) ? await db.reorderOrder.findUnique({ where: { id } }) : null;
  if (cur && productIds && !productIds.has(cur.productId)) throw forbidden('Таны бараа биш');
  // Аудит #151: өөр нийлүүлэгчийн тэмдгийг цуцлахгүй
  if (cur && scope === 'SUPPLIER' && shopId !== null && cur.shopId !== null && cur.shopId !== shopId) throw forbidden('Энэ тэмдгийг цуцлах эрхгүй');
  if (cur && cur.scope !== scope) throw forbidden('Энэ тэмдгийг цуцлах эрхгүй');
  if (!cur || cur.receivedAt || cur.cancelledAt) throw notFound('Идэвхтэй захиалга олдсонгүй');
  await db.$transaction(async (tx) => {
    await tx.reorderOrder.update({ where: { id }, data: { cancelledAt: new Date() } });
    await writeAudit(actor, 'outflow.reorder-cancel', 'ReorderOrder', String(id), { productId: cur.productId, qty: cur.qty, expectedDay: cur.expectedDay }, tx);
  });
  bustReorder();
  return { ok: true };
}

/** Нэг барааны нөөцийн дэлгэрэнгүй + өмнөх захиалгууд */
export async function reorderDetail(actor: UserActor, productIdIn: unknown) {
  assertSA(actor);
  return reorderDetailOf(productIdIn);
}
export async function reorderDetailOf(productIdIn: unknown, scope: ReorderScope = 'OWNER', shopId: number | null = null) {
  const id = Number(productIdIn);
  const m = await computeReorder();
  const cfg = await getConfig();
  // Аудит #151: нийлүүлэгч зөвхөн өөрийн дэлгүүрийн тэмдгийн түүхийг харна
  const history = await db.reorderOrder.findMany({ where: { productId: id, scope, ...(scope === 'SUPPLIER' && shopId !== null ? { shopId } : {}) }, orderBy: { orderedAt: 'desc' }, take: 10 });
  const x = m.get(id);
  const info = x && scope === 'SUPPLIER' ? { ...x, level: x.sup.level, order: x.sup.order, days: x.sup.days, worstLabel: x.sup.worstLabel, variants: x.variants.map((v) => ({ ...v, level: v.supLevel, order: v.supOrder })) } : x;
  return { info: info ?? null, leadDays: cfg.leadDays, urgentDays: cfg.urgentDays, defaultExpected: addDays(ubDay(), cfg.leadDays), history };
}

// ───────────── Гаралтаа хангаагүй пэйж (#121) ─────────────
/**
 * Бүүст ≥ 1, 5+ хоног тасралтгүй асаалттай бараа. Пэйж = операторын захиалгад сонгосон пэйж (сүүлийн 14 бүтэн өдөрт захиалга орсон бүх пэйж).
 * Пэйж бүрийн сүүлийн 2 бүтэн өдрийн (уржигдар + өчигдөр) захиалгын тоо < $ бол 🔴 хангаагүй. Зөвхөн анхааруулга — унтраах эсэхийг хүн шийднэ.
 */
export const SHORT_BOOST_DAYS = 5;
export interface PageShortRow {
  productId: number; code: string; name: string; zones: number; dollar: number; adNumber: number | null; ownerName: string | null; boostDays: number;
  days: [string, string];
  pages: { pageId: number; name: string; d2: number; d1: number; total: number; short: boolean }[];
}
let shortCache: { at: number; list: PageShortRow[] } | null = null;
let shortGen = 0;
let shortInflight: { gen: number; p: Promise<PageShortRow[]> } | null = null;
/** Аудит #152 (хурд): 60 сек кэш; зэрэг олон хүсэлт (хүснэгт бүрийн тоолол) нэг л удаа тооцоолно */
async function pageShortfall(fresh = false): Promise<PageShortRow[]> {
  if (!fresh && shortCache && Date.now() - shortCache.at < 60_000) return shortCache.list;
  if (!fresh && shortInflight && shortInflight.gen === shortGen) return shortInflight.p;
  const gen = shortGen;
  const p = pageShortfallNow(gen);
  if (!fresh) shortInflight = { gen, p };
  try { return await p; } finally { if (shortInflight?.p === p) shortInflight = null; }
}
async function pageShortfallNow(gen: number): Promise<PageShortRow[]> {
  const now = Date.now();
  const today = ubDay(); const yest = addDays(today, -1); const d2 = addDays(today, -2);
  const pms = await db.productMarketing.findMany({ where: { zones: { gte: 1 }, boostOnAt: { lte: new Date(now - SHORT_BOOST_DAYS * 24 * HOUR) } } });
  if (!pms.length) { if (gen === shortGen) shortCache = { at: now, list: [] }; return []; }
  const ids = pms.map((x) => x.productId);
  const [products, rows] = await Promise.all([
    db.product.findMany({ where: { id: { in: ids }, status: { not: 'ARCHIVED' } }, select: { id: true, code: true, name: true } }),
    db.$queryRaw<{ productId: number; pageId: number; name: string; d2: number; d1: number }[]>`
      SELECT l."productId", o."pageId", p.name,
        count(DISTINCT o.id) FILTER (WHERE (o."confirmedAt" + interval '8 hours')::date = ${dateOnly(d2)}::date)::int AS d2,
        count(DISTINCT o.id) FILTER (WHERE (o."confirmedAt" + interval '8 hours')::date = ${dateOnly(yest)}::date)::int AS d1
      FROM "Order" o JOIN "OrderLine" l ON l."orderId" = o.id JOIN "Page" p ON p.id = o."pageId"
      WHERE o."confirmedAt" >= ${ubDayStart(addDays(today, -14))} AND o."confirmedAt" < ${ubDayStart(today)} AND ${COUNTED} AND l."productId" IN (${Prisma.join(ids)})
      GROUP BY 1, 2, 3`,
  ]);
  const pmap = new Map(products.map((p) => [p.id, p]));
  const byP = new Map<number, typeof rows>();
  for (const r of rows) { const a = byP.get(r.productId) ?? []; a.push(r); byP.set(r.productId, a); }
  const list: PageShortRow[] = [];
  for (const m of pms) {
    const p = pmap.get(m.productId); const pg = byP.get(m.productId);
    if (!p || !pg?.length) continue;
    const pages = pg.map((r) => ({ pageId: r.pageId, name: r.name, d2: r.d2, d1: r.d1, total: r.d2 + r.d1, short: r.d2 + r.d1 < m.dollar }))
      .sort((a, b) => Number(b.short) - Number(a.short) || a.total - b.total || a.name.localeCompare(b.name));
    if (!pages.some((x) => x.short)) continue;
    list.push({ productId: p.id, code: p.code, name: p.name, zones: m.zones, dollar: m.dollar, adNumber: m.adNumber, ownerName: m.ownerName,
      boostDays: Math.floor((now - m.boostOnAt!.getTime()) / (24 * HOUR)), days: [d2, yest], pages });
  }
  list.sort((a, b) => b.pages.filter((x) => x.short).length - a.pages.filter((x) => x.short).length || a.name.localeCompare(b.name));
  if (gen === shortGen) shortCache = { at: now, list };
  return list;
}
export async function pageShortView(actor: UserActor) {
  assertView(actor);
  return { rows: await pageShortfall(), boostDays: SHORT_BOOST_DAYS };
}
