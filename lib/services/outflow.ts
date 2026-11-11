import { Prisma, type Role } from '@prisma/client';
import { db } from '../db';
import { badRequest, conflict, forbidden, notFound } from '../errors';
import { writeAudit } from '../audit';
import { canEdit, canSeeCost } from '../permissions';
import { dateOnly, isYmd, ubDay, ubDayStart, ymdOf } from '../ubdate';
import { addDays } from './delivery/core';
import { productStockTotals } from './stock/views';
import type { UserActor } from './users';

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
}
export const DEFAULT_CFG: OutflowConfig = { claimTarget: 5, claimExpireDays: 7, watchHours: 8, defaultDollar: 5, oppCost: 1200, deliveryCost: 5000, rate: 3600, costPct: 35, lowProfit: 1500 };
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
  return { claimTarget: c.claimTarget, claimExpireDays: c.claimExpireDays };
}
/** Ажлын цонхны тоо, хоног — Ахлах/Админ/СА; мөнгөн зардал, ханш, босго, цаг — зөвхөн Супер админ */
export async function setConfig(actor: UserActor, b: Record<string, unknown>) {
  assertLead(actor);
  const cur = await getConfig();
  const next: OutflowConfig = { ...cur };
  if (b.claimTarget !== undefined) next.claimTarget = cleanInt(b.claimTarget, '«Хийсэн» захиалгын тоо', 1, 1000);
  if (b.claimExpireDays !== undefined) next.claimExpireDays = cleanInt(b.claimExpireDays, 'Чөлөөлөх хоног', 1, 365);
  const money = ['oppCost', 'deliveryCost', 'rate', 'costPct', 'lowProfit', 'watchHours', 'defaultDollar'] as const;
  if (money.some((k) => b[k] !== undefined)) {
    assertSA(actor);
    if (b.oppCost !== undefined) next.oppCost = cleanInt(b.oppCost, 'Опп цалин', 0, 1_000_000);
    if (b.deliveryCost !== undefined) next.deliveryCost = cleanInt(b.deliveryCost, 'Хүргэлтийн цалин', 0, 1_000_000);
    if (b.rate !== undefined) next.rate = cleanInt(b.rate, 'Долларын ханш', 1, 100_000);
    if (b.costPct !== undefined) next.costPct = cleanInt(b.costPct, 'Өртгийн хувь', 0, 100);
    if (b.lowProfit !== undefined) next.lowProfit = cleanInt(b.lowProfit, 'Ашгийн босго', 0, 10_000_000);
    if (b.watchHours !== undefined) next.watchHours = cleanInt(b.watchHours, 'Ажиглах цаг', 1, 24);
    if (b.defaultDollar !== undefined) next.defaultDollar = cleanInt(b.defaultDollar, 'Анхдагч $', 1, 10_000);
  }
  const json = next as unknown as Prisma.InputJsonValue;
  await db.$transaction(async (tx) => {
    await tx.appSetting.upsert({ where: { key: KEY_CFG }, create: { key: KEY_CFG, value: json, updatedById: actor.id }, update: { value: json, updatedById: actor.id } });
    await writeAudit(actor, 'outflow.config', 'AppSetting', KEY_CFG, { before: cur, after: next } as unknown as Prisma.InputJsonValue, tx, ['money']);
  });
  cfgCache = null;
  return next;
}

// ───────────── Гарцын тоолол (нэг дүрэм — бүх цонхонд) ─────────────

/** «Тоологдох» захиалга: төлбөр хүлээж буйгаас бусад; тэр өдөртөө (баталгаажсан UB өдөр) цуцлагдсан орохгүй */
const COUNTED = Prisma.sql`o.status <> 'PENDING_PAYMENT' AND o."confirmedAt" IS NOT NULL
  AND NOT (o.status = 'CANCELLED' AND (o."cancelledAt" IS NULL OR (o."cancelledAt" + interval '8 hours')::date <= (o."confirmedAt" + interval '8 hours')::date))`;
/** Одоогийн (амьд) тоолол — цуцлагдсан бүгд хасагдана (ажлын цонхны «Хийсэн») */
const LIVE = Prisma.sql`o.status NOT IN ('PENDING_PAYMENT', 'CANCELLED') AND o."confirmedAt" IS NOT NULL`;

interface DayAgg { productId: number; day: string; qty: number; revenue: number; orderShare: number; orders: number }
async function unitsByDay(from: string, to: string, productIds?: number[]): Promise<DayAgg[]> {
  const pf = productIds ? (productIds.length ? Prisma.sql`AND l."productId" IN (${Prisma.join(productIds)})` : Prisma.sql`AND false`) : Prisma.empty;
  const rows = await db.$queryRaw<{ productId: number; day: Date; qty: number; revenue: number; share: number; orders: number }[]>`
    SELECT l."productId", (o."confirmedAt" + interval '8 hours')::date AS day, sum(l.qty)::int AS qty, sum(l.qty * l."unitPrice")::int AS revenue,
           sum(CASE WHEN o.subtotal - o.discount > 0 THEN (l.qty * l."unitPrice")::numeric / (o.subtotal - o.discount) ELSE 1 END)::float8 AS share,
           count(DISTINCT o.id)::int AS orders
    FROM "Order" o JOIN "OrderLine" l ON l."orderId" = o.id
    WHERE o."confirmedAt" >= ${ubDayStart(from)} AND o."confirmedAt" < ${ubDayStart(addDays(to, 1))} AND ${COUNTED} ${pf}
    GROUP BY 1, 2`;
  return rows.map((r) => ({ productId: r.productId, day: ymdOf(r.day), qty: r.qty, revenue: r.revenue, orderShare: r.share, orders: r.orders }));
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
    SELECT DISTINCT ON ("productId") "productId", at, dollar, zones FROM "BoostEvent" WHERE "productId" IN (${Prisma.join(productIds)}) AND at < ${new Date(fromMs)}
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
/** Хугацааны бүүстийн зардал (₮) — асаалттай цагаар хувь тэнцүүлэн */
const boostCost = (segs: Seg[] | undefined, fromMs: number, toMs: number, rate: number) =>
  Math.round((segs ?? []).reduce((s, g) => { const a = Math.max(g.from, fromMs), b = Math.min(g.to, toMs); return b > a ? s + (g.dollar * g.zones * rate * (b - a)) / (24 * HOUR) : s; }, 0));
/** Хугацаанд бүүст хамгийн их байсан төлөв (үнэлгээ: хүлээгдэж буй = бүс × $) */
const peakBoost = (segs: Seg[] | undefined, fromMs: number, toMs: number) =>
  (segs ?? []).filter((g) => g.to > fromMs && g.from < toMs).reduce<{ dollar: number; zones: number } | null>((m, g) => (!m || g.zones * g.dollar > m.zones * m.dollar ? { dollar: g.dollar, zones: g.zones } : m), null);

// ───────────── Бүүстийн ашиг ─────────────

export type ProfitStatus = 'DIAMOND' | 'GOOD' | 'LOW' | 'LOSS';
export interface DayProfit {
  day: string; qty: number; orders: number; revenue: number; cost: number; costEstimated: boolean; oppDelivery: number; boost: number;
  profit: number; perUnit: number | null; status: ProfitStatus | null;
}
function profitOf(cfg: OutflowConfig, p: { price: number; costPrice: number | null }, a: { qty: number; revenue: number; orderShare: number; orders: number } | undefined, boost: number, day: string): DayProfit {
  const qty = a?.qty ?? 0, revenue = a?.revenue ?? 0;
  const unitCost = p.costPrice ?? Math.round((p.price * cfg.costPct) / 100);
  const cost = qty * unitCost;
  // Эзний шийдвэр (#113): опп + хүргэлтийн зардал зарагдсан ширхэг бүрээс бүтнээр (1,200₮ + 5,000₮)
  const oppDelivery = qty * (cfg.oppCost + cfg.deliveryCost);
  const profit = revenue - cost - oppDelivery - boost;
  const perUnit = qty > 0 ? Math.round(profit / qty) : boost > 0 ? -boost : null;
  let status: ProfitStatus | null = null;
  if (boost > 0) {
    if (perUnit === null || perUnit < 0) status = 'LOSS';
    else if (perUnit < cfg.lowProfit) status = 'LOW';
    else status = qty > boost / cfg.rate ? 'DIAMOND' : 'GOOD';
  }
  return { day, qty, orders: a?.orders ?? 0, revenue, cost, costEstimated: p.costPrice === null, oppDelivery, boost, profit, perUnit, status };
}

// ───────────── Анхааруулга ─────────────

export type AlertLevel = 'RED' | 'ORANGE';
export interface BoostAlert {
  productId: number; code: string; name: string; level: AlertLevel; reasons: string[]; pages: { name: string; n: number }[];
  watchedUntil: Date | null; watchedBy: string | null; boostOnAt: Date | null; zones: number; dollar: number; ownerName: string | null;
}
let alertCache: { at: number; list: BoostAlert[] } | null = null;
export function bustOutflowCache() { alertCache = null; }

/** Одоо бүүст асаалттай бараануудын анхааруулга (60 сек кэш) */
export async function computeAlerts(fresh = false): Promise<BoostAlert[]> {
  if (!fresh && alertCache && Date.now() - alertCache.at < 60_000) return alertCache.list;
  const cfg = await getConfig();
  const now = Date.now();
  const today = ubDay(); const yest = addDays(today, -1); const d2 = addDays(today, -2);
  const todayStart = ubDayStart(today).getTime(), yStart = ubDayStart(yest).getTime(), d2Start = ubDayStart(d2).getTime();
  const pms = await db.productMarketing.findMany({ where: { zones: { gt: 0 } } });
  if (!pms.length) { alertCache = { at: now, list: [] }; return []; }
  const ids = pms.map((x) => x.productId);
  const [products, segs, aggs, watches] = await Promise.all([
    db.product.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, name: true, price: true, costPrice: true } }),
    boostSegments(ids, d2Start, now),
    unitsByDay(d2, yest, ids),
    db.boostWatch.findMany({ where: { productId: { in: ids }, until: { gt: new Date(now) } }, orderBy: { until: 'desc' } }),
  ]);
  const pmap = new Map(products.map((p) => [p.id, p]));
  const aggMap = new Map(aggs.map((a) => [`${a.productId}|${a.day}`, a]));
  const watchMap = new Map<number, (typeof watches)[number]>(); for (const w of watches) if (!watchMap.has(w.productId)) watchMap.set(w.productId, w);
  // Өнөөдөр бүүст асаасан цагаас хойшх захиалга (амьд тоолол), пэйжээр
  const sinceRows = await db.$queryRaw<{ productId: number; since: Date; orders: number }[]>`
    SELECT x."productId", x.since, count(DISTINCT o.id)::int AS orders
    FROM (SELECT "productId", CASE WHEN "boostOnAt" > ${new Date(now - 24 * HOUR)} THEN "boostOnAt" ELSE GREATEST("boostOnAt", ${new Date(todayStart)}) END AS since
          FROM "ProductMarketing" WHERE zones > 0 AND "boostOnAt" IS NOT NULL) x
    LEFT JOIN "OrderLine" l ON l."productId" = x."productId"
    LEFT JOIN "Order" o ON o.id = l."orderId" AND o."confirmedAt" >= x.since AND ${LIVE}
    GROUP BY 1, 2`;
  const since = new Map(sinceRows.map((r) => [r.productId, r]));
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
    const yb = boostCost(sg, yStart, todayStart, cfg.rate);
    if (yb > 0) {
      const y = profitOf(cfg, p, aggMap.get(`${pm.productId}|${yest}`), yb, yest);
      const isNew = !!pm.boostOnAt && pm.boostOnAt.getTime() >= d2Start;
      if (y.status === 'LOSS') {
        const b2 = boostCost(sg, d2Start, yStart, cfg.rate);
        const prev = b2 > 0 ? profitOf(cfg, p, aggMap.get(`${pm.productId}|${d2}`), b2, d2) : null;
        if (isNew) up('RED', 'Алдагдалтай бүүст (шинэ бүүст, өчигдөр алдагдалтай) — яаралтай унтраа');
        else if (prev?.status === 'LOSS') up('RED', 'Алдагдалтай бүүст — дараалан 2 өдөр алдагдалтай, яаралтай унтраа');
        else up('ORANGE', 'Өчигдөр алдагдалтай — ажиглаж байна (маргааш давтагдвал яаралтай)');
      } else if (y.status === 'LOW') up('ORANGE', 'Ашиг багассан — алдагдал руу дөхөж байна, бүүстээ шалгана уу');
      if (!pageDays.has(pm.productId) && level) pageDays.set(pm.productId, yest);
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
  alertCache = { at: now, list };
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
  const red = open.filter((a) => a.level === 'RED').length, orange = open.filter((a) => a.level === 'ORANGE').length;
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
  daily: number[]; weekTotal: number; avg: number; phones: number[]; phoneWeek: number;
  stock?: { total: number; available: number; driver: number };
  alert?: AlertLevel | null; profit?: { status: ProfitStatus | null; perUnit: number | null } | null;
  /** Мөрийн ард жижиг тэмдэг — дарахад дэлгэрэнгүй */
  alertInfo?: { level: AlertLevel; reasons: string[]; pages: { name: string; n: number }[]; watchedUntil: Date | null; watchedBy: string | null } | null;
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

async function allRows(): Promise<OutflowRow[]> {
  const today = ubDay(); const from = addDays(today, -6);
  const k = today;
  if (tableCache && tableCache.key === k && Date.now() - tableCache.at < 20_000) return tableCache.rows;
  const [products, pms, aggs, phones] = await Promise.all([
    db.product.findMany({ where: { status: { not: 'ARCHIVED' } }, select: { id: true, code: true, name: true, price: true, images: { where: { isMain: true }, select: { fileKey: true }, take: 1 } } }),
    db.productMarketing.findMany(),
    unitsByDay(from, today),
    phoneCounts(from, today),
  ]);
  const pm = new Map(pms.map((x) => [x.productId, x]));
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, -i));
  const di = new Map(days.map((d, i) => [d, i]));
  const daily = new Map<number, number[]>();
  for (const a of aggs) { const i = di.get(a.day); if (i === undefined) continue; const arr = daily.get(a.productId) ?? Array(7).fill(0); arr[i] += a.qty; daily.set(a.productId, arr); }
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
      daily: d, weekTotal: week, avg: Math.round((week / 7) * 10) / 10, phones: ph.get(p.id) ?? Array(7).fill(0), phoneWeek: phW.get(p.id) ?? 0,
    } as OutflowRow;
  });
  tableCache = { at: Date.now(), key: k, rows };
  return rows;
}
export function bustTable() { tableCache = null; }

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
  let prof = new Map<number, DayProfit>();
  if (sa) prof = await yesterdayProfits(rows.filter((r) => r.zones > 0 || p.status).map((r) => r.id));
  if (sa && p.status) rows = rows.filter((r) => prof.get(r.id)?.status === p.status);
  const dir = p.dir === 'asc' ? 1 : -1;
  const key = p.sort ?? 'week';
  const val = (r: OutflowRow): number | string => {
    if (key === 'name') return r.name;
    if (key === 'avg') return r.avg;
    if (key === 'zones') return r.zones;
    if (key === 'profit') return prof.get(r.id)?.perUnit ?? -1e12;
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
    if (sa) { const pr = prof.get(r.id); r.profit = pr ? { status: pr.status, perUnit: pr.perUnit } : null; }
  }
  const all = await allRows();
  const watchedN = alerts.filter((a) => a.watchedUntil && a.watchedUntil.getTime() > now).length;
  const counts = {
    all: all.length, boost: all.filter((r) => r.zones > 0).length, noboost: all.filter((r) => r.zones === 0).length,
    red: alerts.filter((a) => a.level === 'RED' && !(a.watchedUntil && a.watchedUntil.getTime() > now)).length,
    orange: alerts.filter((a) => a.level === 'ORANGE' && !(a.watchedUntil && a.watchedUntil.getTime() > now)).length,
    watched: watchedN,
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
  for (const p of products) out.set(p.id, profitOf(cfg, p, am.get(p.id), boostCost(segs.get(p.id), ubDayStart(y).getTime(), ubDayStart(ubDay()).getTime(), cfg.rate), y));
  return out;
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
    bustOutflowCache(); bustTable();
    return r;
  });
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
  bustTable();
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
  await db.$transaction(async (tx) => {
    for (const productId of ids) {
      await tx.productMarketing.upsert({ where: { productId }, create: { productId, ownerId: user?.id ?? null, ownerName: user?.name ?? null, updatedByName: actor.name },
        update: { ownerId: user?.id ?? null, ownerName: user?.name ?? null, updatedByName: actor.name } });
    }
    await writeAudit(actor, 'outflow.owner', 'ProductMarketing', ids.length === 1 ? String(ids[0]) : null, { count: ids.length, owner: user?.name ?? null }, tx);
  }, { timeout: 60_000 });
  bustTable();
  return { updated: ids.length };
}

/** Шүүсэн бүх барааны дугаар (бөөнөөр оноохдоо) */
export async function filteredIds(actor: UserActor, p: TableParams) {
  assertLead(actor);
  const r = await outflowTableIds(actor, p);
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
  const rows = await db.$queryRaw<{ userId: string; userName: string; pages: number; orders: number }[]>`
    SELECT mp."userId", max(mp."userName") AS "userName", count(DISTINCT mp."pageId")::int AS pages, count(DISTINCT o.id)::int AS orders
    FROM "MarketingPage" mp
    LEFT JOIN "Order" o ON o."pageId" = mp."pageId" AND o."confirmedAt" >= ${ubDayStart(from)} AND o."confirmedAt" < ${ubDayStart(addDays(to, 1))} AND ${COUNTED}
    GROUP BY 1 ORDER BY orders DESC`;
  return { from, to, rows: rows.map((r, i) => ({ ...r, rank: i + 1, perPage: r.pages ? Math.round(r.orders / r.pages) : 0 })), totals: { marketers: rows.length, pages: rows.reduce((s, r) => s + r.pages, 0), orders: rows.reduce((s, r) => s + r.orders, 0) } };
}

// ───────────── Ажлын цонх ─────────────

/** Идэвхтэй сонголтын явц: «Хийсэн» (N захиалга) эсвэл хугацаа дууссан (N хоног) */
export async function syncClaims() {
  const cfg = await getConfig();
  const active = await db.workClaim.findMany({ where: { status: 'ACTIVE' } });
  if (!active.length) return 0;
  const prog = await db.$queryRaw<{ id: number; n: number }[]>`
    SELECT c.id, count(DISTINCT o.id)::int AS n FROM "WorkClaim" c
    LEFT JOIN "OrderLine" l ON l."productId" = c."productId"
    LEFT JOIN "Order" o ON o.id = l."orderId" AND o."confirmedAt" >= c."claimedAt" AND ${LIVE}
    WHERE c.status = 'ACTIVE' GROUP BY 1`;
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

export async function workWindow(actor: UserActor, p: { tab?: string; q?: string; page?: number }) {
  assertView(actor);
  await syncClaims();
  const cfg = await getConfig();
  const today = ubDay(); const from = addDays(today, -2);
  const q = cleanText(p.q, 60);
  const sold = new Set((await unitsByDay(from, today)).filter((a) => a.qty > 0).map((a) => a.productId));
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
  const p = await db.product.findUnique({ where: { id: productId }, select: { code: true, name: true } });
  if (!p) throw notFound('Бараа олдсонгүй');
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
    await tx.workClaim.update({ where: { id: c.id }, data: { status: own ? 'RETURNED' : 'CANCELLED', endedAt: new Date(), endedByName: actor.name } });
    await writeAudit(actor, own ? 'outflow.claim_returned' : 'outflow.claim_cancelled', 'ProductMarketing', String(c.productId), { by: c.userName }, tx);
  });
  return { ok: true };
}

// ───────────── Өөрийн ажил ─────────────

export async function myWork(actor: UserActor) {
  assertView(actor);
  await syncClaims();
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
    db.boostEvent.findMany({ where: { at: { gte: new Date(d0), lt: new Date(d1) }, byId: { not: null } }, select: { productId: true, byId: true } }),
  ]);
  const by = new Map<string, Set<number>>();
  for (const u of users) by.set(u.id, new Set());
  for (const o of owned) by.get(o.ownerId!)?.add(o.productId);
  for (const e of evs) by.get(e.byId!)?.add(e.productId);
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
      const orders = am.get(pid)?.qty ?? 0;
      const expected = pk ? pk.zones * (pk.dollar || 5) : 0;
      return { productId: pid, code: pn.get(pid)?.code ?? '', name: pn.get(pid)?.name ?? '', dollar: pk?.dollar ?? null, zones: pk?.zones ?? 0, expected, orders, cls: classify(orders, expected) };
    }).filter((x) => x.zones > 0 || x.orders > 0).sort((a, b) => b.orders - a.orders);
    const s = sm.get(u.id);
    return {
      userId: u.id, name: u.name, pages: pc.get(u.id) ?? 0, items,
      boostCount: items.reduce((x, i) => x + i.zones, 0), orderCount: items.reduce((x, i) => x + i.orders, 0),
      excellent: items.filter((i) => i.cls === 'EXCELLENT').length, good: items.filter((i) => i.cls === 'GOOD').length, poor: items.filter((i) => i.cls === 'POOR').length,
      score: s ? { score: s.score, salaryAmount: s.salaryAmount, note: s.note, scoredByName: s.scoredByName, updatedAt: s.updatedAt } : null,
      canScore: lead && u.id !== actor.id,
    };
  }).sort((a, b) => b.orderCount - a.orderCount);
  return { date, rows, canScore: lead };
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
  assertLead(actor);
  const userId = String(b.userId ?? '');
  if (userId === actor.id) throw forbidden('Өөрийгөө үнэлэхгүй');
  if (!isYmd(b.date)) throw badRequest('Огноо буруу');
  const date = b.date;
  const u = await db.user.findFirst({ where: { id: userId, roles: { hasSome: MKT } }, select: { id: true, name: true } });
  if (!u) throw badRequest('Маркетинг ажилтан олдсонгүй');
  const score = b.score === '' || b.score === null || b.score === undefined ? null : cleanInt(b.score, 'Оноо (1–10)', 1, 10);
  const salaryAmount = cleanInt(b.salaryAmount, 'Цалин', 0, 100_000_000);
  const note = cleanText(b.note, 500);
  const ev = await evaluation({ ...actor }, date);
  const row = ev.rows.find((r) => r.userId === userId);
  const locked = await db.staffSalaryRecord.findFirst({ where: { userId, isLocked: true, periodStart: { lte: dateOnly(date) }, periodEnd: { gte: dateOnly(date) } }, select: { periodLabel: true } });
  await db.$transaction(async (tx) => {
    const old = await tx.marketingScore.findUnique({ where: { userId_date: { userId, date: dateOnly(date) } } });
    await tx.marketingScore.upsert({
      where: { userId_date: { userId, date: dateOnly(date) } },
      create: { userId, userName: u.name, date: dateOnly(date), score, salaryAmount, note, boostCount: row?.boostCount ?? 0, orderCount: row?.orderCount ?? 0, scoredById: actor.id, scoredByName: actor.name },
      update: { score, salaryAmount, note, boostCount: row?.boostCount ?? 0, orderCount: row?.orderCount ?? 0, scoredById: actor.id, scoredByName: actor.name },
    });
    await writeAudit(actor, 'outflow.score', 'User', userId, { name: u.name, date, before: old ? { score: old.score, salaryAmount: old.salaryAmount } : null, after: { score, salaryAmount } }, tx, ['money']);
  });
  return { ok: true, warning: locked ? `${locked.periodLabel}-ны цалин цоожтой — нягтлан цоож тайлж дахин хадгалах хүртэл цалинд орохгүй` : null };
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
    return profitOf(cfg, p, am.get(d), boostCost(segs.get(id), s, e, cfg.rate), d);
  });
  const unitCost = p.costPrice ?? Math.round((p.price * cfg.costPct) / 100);
  const margin = p.price - unitCost - cfg.oppCost - cfg.deliveryCost;
  const dailyBoost = (pm?.zones ?? 0) * (pm?.dollar ?? cfg.defaultDollar) * cfg.rate;
  return {
    product: { id: p.id, code: p.code, name: p.name, price: p.price, costPrice: p.costPrice, unitCost, costEstimated: p.costPrice === null },
    cfg: { oppCost: cfg.oppCost, deliveryCost: cfg.deliveryCost, rate: cfg.rate, costPct: cfg.costPct, lowProfit: cfg.lowProfit },
    boost: { dollar: pm?.dollar ?? cfg.defaultDollar, zones: pm?.zones ?? 0, dailyBoost, boostOnAt: pm?.boostOnAt ?? null },
    marginBeforeBoost: margin,
    breakEven: dailyBoost > 0 && margin > 0 ? Math.ceil(dailyBoost / margin) : null,
    lowProfitAt: dailyBoost > 0 && margin > cfg.lowProfit ? Math.ceil(dailyBoost / (margin - cfg.lowProfit)) : null,
    days,
  };
}
