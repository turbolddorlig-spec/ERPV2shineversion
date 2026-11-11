import { Prisma } from '@prisma/client';
import { db } from '../db';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors';
import { writeAudit } from '../audit';
import { canEdit, canView } from '../permissions';
import { dateOnly, isYmd, ubDay, ubDayStart, ymdOf } from '../ubdate';
import { addDays } from './delivery/core';
import { createUser, resetPassword, type UserActor } from './users';

type Tx = Prisma.TransactionClient;

/**
 * Модуль 7в — Нийлүүлэгч (гадны дэлгүүр), хуучин «Гадны дэлгүүр удирдлага»-ын логикоор (#96–#98):
 *   борлуулалт − (1 ширхэгийн суутгал × авсан тоо) = цэвэр дүн → нийлүүлэгчид шилжүүлнэ.
 * Засвар (эзэнд хохиролгүй):
 *   • өдөр = ПАДААНЫ өдөр (Улаанбаатар), зөвхөн ХҮРГЭГДСЭН, үйлчлүүлэгчийн АВСАН тоо; хөнгөлөлтийг хямдарсан бараа өөрөө хүлээнэ (мөрийн үнэ);
 *   • нэг бараа нэг л нийлүүлэгчид (DB partial unique), хугацаагаар; тооцоог сервер хийнэ; суутгалыг гараар зөвхөн Супер админ;
 *   • шилжүүлсэн өдөр түгжигдэнэ; дараа нь гарсан буцаалт/нэмэгдэл автоматаар зөвхөн нийлүүлэгчийн барааны дүнгээр дараагийн шилжүүлгэд;
 *   • жолоочийн нэмэлт борлуулалт (EXTRA_SALE) мөн тооцогдоно. Барааны үлдэгдэлд огт хүрэхгүй.
 */
const OPEN = 'OPEN';
const DONE = 'TRANSFERRED';
const SYNC_DAYS = 90;
const MAX_RANGE = 93;

const money = (n: number) => `${n.toLocaleString('en-US')}₮`;
const isSA = (a: UserActor) => a.roles.includes('SUPER_ADMIN');
const assertSA = (a: UserActor) => { if (!isSA(a)) throw forbidden('Суутгалын дүнг зөвхөн Супер админ өөрчилнө'); };
const assertAdmin = (a: UserActor) => { if (!canEdit(a.roles, 'supplier')) throw forbidden('Нийлүүлэгчийн тооцоог Супер админ, Админ хөтөлнө'); };
const cleanInt = (v: unknown, label: string, max = 100_000_000) => {
  const n = v === '' || v === null || v === undefined ? 0 : Number(v);
  if (!Number.isInteger(n) || n < 0 || n > max) throw badRequest(`${label} буруу`);
  return n;
};
const cleanText = (v: unknown, max: number) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const cleanDate = (v: unknown, label = 'Огноо') => { if (!isYmd(v)) throw badRequest(`${label} буруу`); return v; };
const shopIdOf = (v: unknown) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw badRequest('Дэлгүүр буруу'); return n; };
const lockShop = (tx: Tx, shopId: number) => tx.$executeRaw`SELECT pg_advisory_xact_lock(7300, ${shopId}::int)`;

// ───────────── Шууд тооцоо (падааны өдрөөр) ─────────────

interface LiveItem { date: string; source: string; orderNumber: string; productId: number; qty: number; sales: number }

/** Хүргэгдсэн (авсан тоо) мөрүүд + жолоочийн нэмэлт борлуулалт — тухайн өдөр тухайн дэлгүүрт хувиарлагдсан бараагаар */
async function liveItems(tx: Tx | typeof db, shopId: number, from: string, to: string): Promise<LiveItem[]> {
  const rows = await tx.$queryRaw<{ date: Date; source: string; orderNumber: string; productId: number; qty: number; sales: number }[]>`
    WITH asg AS (SELECT "productId", "fromDate", "toDate" FROM "SupplierProduct" WHERE "shopId" = ${shopId})
    SELECT h.date, 'o:' || o.id AS source, o.number AS "orderNumber", l."productId",
           sum(l.qty - l."refusedQty")::int AS qty, sum((l.qty - l."refusedQty") * l."unitPrice")::int AS sales
    FROM "Handover" h
    JOIN "HandoverOrder" ho ON ho."handoverId" = h.id AND ho."removedAt" IS NULL
    JOIN "Order" o ON o.id = ho."orderId" AND o."handoverId" = h.id AND o.status = 'DELIVERED'
    JOIN "OrderLine" l ON l."orderId" = o.id
    JOIN asg a ON a."productId" = l."productId" AND a."fromDate" <= h.date AND (a."toDate" IS NULL OR a."toDate" > h.date)
    WHERE h.date >= ${dateOnly(from)}::date AND h.date <= ${dateOnly(to)}::date
    GROUP BY 1, 2, 3, 4 HAVING sum(l.qty - l."refusedQty") > 0
    UNION ALL
    SELECT (d."createdAt" + interval '8 hours')::date, 'd:' || d.id, 'Нэмэлт борлуулалт · ' || d."driverName", v."productId",
           sum(dl.qty)::int, sum(dl.qty * dl."unitPrice")::int
    FROM "DriverDoc" d
    JOIN "DriverDocLine" dl ON dl."docId" = d.id
    JOIN "ProductVariant" v ON v.id = dl."variantId"
    JOIN asg a ON a."productId" = v."productId" AND a."fromDate" <= (d."createdAt" + interval '8 hours')::date
      AND (a."toDate" IS NULL OR a."toDate" > (d."createdAt" + interval '8 hours')::date)
    WHERE d.kind = 'EXTRA_SALE' AND d."createdAt" >= ${ubDayStart(from)} AND d."createdAt" < ${ubDayStart(addDays(to, 1))}
    GROUP BY 1, 2, 3, 4 HAVING sum(dl.qty) > 0`;
  return rows.map((r) => ({ ...r, date: ymdOf(r.date) }));
}

/** Цуцалсан тоо (падаанд байсан, цуцлагдсан + хүлээж аваагүй) ба дуусаагүй захиалгын тоо */
async function dayExtras(tx: Tx | typeof db, shopId: number, from: string, to: string) {
  const rows = await tx.$queryRaw<{ date: Date; productId: number | null; cancelled: number; unfinished: number }[]>`
    WITH asg AS (SELECT "productId", "fromDate", "toDate" FROM "SupplierProduct" WHERE "shopId" = ${shopId})
    SELECT h.date, l."productId",
           sum(CASE WHEN o.status = 'CANCELLED' THEN l.qty WHEN o.status = 'DELIVERED' THEN l."refusedQty" ELSE 0 END)::int AS cancelled,
           count(DISTINCT CASE WHEN o.status NOT IN ('DELIVERED', 'CANCELLED') THEN o.id END)::int AS unfinished
    FROM "Handover" h
    JOIN "HandoverOrder" ho ON ho."handoverId" = h.id AND ho."removedAt" IS NULL
    JOIN "Order" o ON o.id = ho."orderId" AND o."handoverId" = h.id
    JOIN "OrderLine" l ON l."orderId" = o.id
    JOIN asg a ON a."productId" = l."productId" AND a."fromDate" <= h.date AND (a."toDate" IS NULL OR a."toDate" > h.date)
    WHERE h.date >= ${dateOnly(from)}::date AND h.date <= ${dateOnly(to)}::date
    GROUP BY 1, 2`;
  return rows.map((r) => ({ ...r, date: ymdOf(r.date) }));
}

export interface Line {
  productId: number; code: string; name: string; qty: number; cancelledQty: number; unitPrice: number; sales: number;
  operatorCost: number; deliveryCost: number; marketingCost: number; otherCost: number; otherNote: string;
  deduction: number; net: number; manual: boolean; manualNote: string;
  perUnit: { operatorCost: number; deliveryCost: number; marketingCost: number; otherCost: number };
}
export interface AdjView { id: number; kind: string; kindLabel: string; sourceDate: string | null; orderNumber: string | null; productName: string | null; qty: number; sales: number; deduction: number; amount: number; reason: string; createdAt: Date; appliedDate: string | null }
export interface DayCalc {
  shopId: number; date: string; status: 'OPEN' | 'TRANSFERRED'; lines: Line[];
  totals: { qty: number; cancelledQty: number; sales: number; deductions: number; net: number };
  unfinished: number; adjustments: AdjView[]; adjTotal: number; payable: number; carry: number;
  transferredAt: Date | null; transferredByName: string | null; version: number;
  /** Шилжүүлсний дараа илэрсэн буцаалт/нэмэгдэл (шилжүүлсэн өдөрт) */
  laterChanges?: AdjView[];
}
type Override = { operatorCost: number; deliveryCost: number; marketingCost: number; otherCost: number; note: string };
type DayRowDb = Prisma.SupplierDayGetPayload<object>;

const KIND_LABEL: Record<string, string> = { REFUND: 'Буцаалт', ADDITION: 'Нэмэгдэл', CARRY: 'Өмнөх үлдэгдэл' };

async function productInfo(tx: Tx | typeof db, ids: number[]) {
  if (!ids.length) return new Map<number, { code: string; name: string }>();
  const ps = await tx.product.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, name: true } });
  return new Map(ps.map((p) => [p.id, { code: p.code, name: p.name }]));
}

/** Нээлттэй (шилжүүлээгүй) өдрүүдийн тооцоо — хүрээгээр нэг удаа уншина */
async function computeLive(tx: Tx | typeof db, shopId: number, from: string, to: string, dayRows: DayRowDb[]) {
  const [items, extras, deds] = await Promise.all([
    liveItems(tx, shopId, from, to),
    dayExtras(tx, shopId, from, to),
    tx.supplierDeduction.findMany({ where: { shopId } }),
  ]);
  const ded = new Map(deds.map((d) => [d.productId, d]));
  const ovByDate = new Map(dayRows.map((d) => [ymdOf(d.date), (d.overrides ?? {}) as Record<string, Override>]));
  const pids = new Set<number>([...items.map((i) => i.productId), ...extras.flatMap((e) => (e.productId ? [e.productId] : []))]);
  const info = await productInfo(tx, [...pids]);
  const byDate = new Map<string, { lines: Map<number, Line>; unfinished: number; items: LiveItem[] }>();
  const slot = (date: string) => { let s = byDate.get(date); if (!s) { s = { lines: new Map(), unfinished: 0, items: [] }; byDate.set(date, s); } return s; };
  const line = (date: string, pid: number) => {
    const s = slot(date);
    let l = s.lines.get(pid);
    if (!l) {
      const p = info.get(pid) ?? { code: String(pid), name: String(pid) };
      const c = ded.get(pid);
      l = { productId: pid, code: p.code, name: p.name, qty: 0, cancelledQty: 0, unitPrice: 0, sales: 0, operatorCost: 0, deliveryCost: 0, marketingCost: 0, otherCost: 0,
        otherNote: c?.otherNote ?? '', deduction: 0, net: 0, manual: false, manualNote: '',
        perUnit: { operatorCost: c?.operatorCost ?? 0, deliveryCost: c?.deliveryCost ?? 0, marketingCost: c?.marketingCost ?? 0, otherCost: c?.otherCost ?? 0 } };
      s.lines.set(pid, l);
    }
    return l;
  };
  for (const i of items) { const l = line(i.date, i.productId); l.qty += i.qty; l.sales += i.sales; slot(i.date).items.push(i); }
  // Хуучин шиг: дуусаагүй захиалга бүрийг өдөрт нэг удаа тоолно (бараа бүрээр давхардуулахгүй)
  const unf = new Map<string, number>();
  for (const e of extras) {
    if (e.productId && e.cancelled > 0) line(e.date, e.productId).cancelledQty += e.cancelled;
    if (e.unfinished > 0) unf.set(e.date, Math.max(unf.get(e.date) ?? 0, e.unfinished));
  }
  if (unf.size) {
    const exact = await tx.$queryRaw<{ date: Date; n: number }[]>`
      WITH asg AS (SELECT "productId", "fromDate", "toDate" FROM "SupplierProduct" WHERE "shopId" = ${shopId})
      SELECT h.date, count(DISTINCT o.id)::int AS n
      FROM "Handover" h
      JOIN "HandoverOrder" ho ON ho."handoverId" = h.id AND ho."removedAt" IS NULL
      JOIN "Order" o ON o.id = ho."orderId" AND o."handoverId" = h.id AND o.status NOT IN ('DELIVERED', 'CANCELLED')
      WHERE h.date >= ${dateOnly(from)}::date AND h.date <= ${dateOnly(to)}::date
        AND EXISTS (SELECT 1 FROM "OrderLine" l JOIN asg a ON a."productId" = l."productId" AND a."fromDate" <= h.date AND (a."toDate" IS NULL OR a."toDate" > h.date) WHERE l."orderId" = o.id)
      GROUP BY 1`;
    for (const r of exact) slot(ymdOf(r.date)).unfinished = r.n;
  }
  const out = new Map<string, { lines: Line[]; unfinished: number; items: LiveItem[] }>();
  for (const [date, s] of byDate) {
    const ov = ovByDate.get(date) ?? {};
    const lines = [...s.lines.values()].map((l) => {
      const o = ov[String(l.productId)];
      const r = o
        ? { ...l, operatorCost: o.operatorCost, deliveryCost: o.deliveryCost, marketingCost: o.marketingCost, otherCost: o.otherCost, manual: true, manualNote: o.note }
        : { ...l, operatorCost: l.perUnit.operatorCost * l.qty, deliveryCost: l.perUnit.deliveryCost * l.qty, marketingCost: l.perUnit.marketingCost * l.qty, otherCost: l.perUnit.otherCost * l.qty };
      r.deduction = r.operatorCost + r.deliveryCost + r.marketingCost + r.otherCost;
      r.net = r.sales - r.deduction;
      r.unitPrice = r.qty > 0 ? Math.round(r.sales / r.qty) : 0;
      return r;
    }).sort((a, b) => a.name.localeCompare(b.name));
    out.set(date, { lines, unfinished: s.unfinished, items: s.items });
  }
  return out;
}

const totalsOf = (lines: Line[]) => ({
  qty: lines.reduce((a, l) => a + l.qty, 0), cancelledQty: lines.reduce((a, l) => a + l.cancelledQty, 0),
  sales: lines.reduce((a, l) => a + l.sales, 0), deductions: lines.reduce((a, l) => a + l.deduction, 0), net: lines.reduce((a, l) => a + l.net, 0),
});

function adjView(a: Prisma.SupplierAdjustmentGetPayload<object>, appliedDates: Map<number, string>): AdjView {
  return { id: a.id, kind: a.kind, kindLabel: KIND_LABEL[a.kind] ?? a.kind, sourceDate: a.sourceDate ? ymdOf(a.sourceDate) : null, orderNumber: a.orderNumber,
    productName: a.productName, qty: a.qty, sales: a.sales, deduction: a.deduction, amount: a.amount, reason: a.reason, createdAt: a.createdAt,
    appliedDate: a.appliedDayId ? appliedDates.get(a.appliedDayId) ?? null : null };
}

// ───────────── Шилжүүлсний дараах буцаалт / нэмэгдэл (автомат) ─────────────

/**
 * Сүүлийн 90 хоногт шилжүүлсэн өдрүүдийн хуулбарыг одоогийн байдалтай харьцуулна:
 * хүргэсний дараа цуцлагдсан/хүлээж аваагүй → БУЦААЛТ (−, зөвхөн нийлүүлэгчийн барааны цэвэр дүн), хожим хүргэгдсэн → НЭМЭГДЭЛ (+).
 */
export async function syncAdjustments(shopId: number) {
  return db.$transaction(async (tx) => {
    await lockShop(tx, shopId);
    const since = addDays(ubDay(), -SYNC_DAYS);
    const days = await tx.supplierDay.findMany({ where: { shopId, status: DONE, date: { gte: dateOnly(since) } }, include: { items: true } });
    if (!days.length) return 0;
    const dates = days.map((d) => ymdOf(d.date)).sort();
    const live = await liveItems(tx, shopId, dates[0]!, dates[dates.length - 1]!);
    const liveMap = new Map(live.map((i) => [`${i.date}|${i.source}|${i.productId}`, i]));
    const deds = new Map((await tx.supplierDeduction.findMany({ where: { shopId } })).map((d) => [d.productId, d]));
    let created = 0;
    const info = await productInfo(tx, [...new Set([...days.flatMap((d) => d.items.map((i) => i.productId)), ...live.map((i) => i.productId)])]);
    for (const day of days) {
      const date = ymdOf(day.date);
      const seen = new Set<string>();
      const todo: { item: Prisma.SupplierDayItemGetPayload<object> | null; l: LiveItem | undefined }[] = [];
      for (const it of day.items) { const k = `${date}|${it.source}|${it.productId}`; seen.add(k); todo.push({ item: it, l: liveMap.get(k) }); }
      for (const l of live) { const k = `${l.date}|${l.source}|${l.productId}`; if (l.date === date && !seen.has(k)) todo.push({ item: null, l }); }
      for (const { item, l } of todo) {
        const eff = item ? item.qty - item.adjustedQty : 0;
        const cur = l?.qty ?? 0;
        const diff = cur - eff;
        if (diff === 0) continue;
        const pid = item?.productId ?? l!.productId;
        const name = info.get(pid)?.name ?? String(pid);
        const orderNumber = item?.orderNumber ?? l!.orderNumber;
        const per = deds.get(pid);
        const perUnitDed = item && item.qty > 0 ? item.deduction / item.qty : (per ? per.operatorCost + per.deliveryCost + per.marketingCost + per.otherCost : 0);
        const x = Math.abs(diff);
        let sales: number;
        if (diff < 0) sales = item && item.qty > 0 ? Math.round((item.sales * x) / item.qty) : 0;
        else sales = l && l.qty > 0 ? Math.round((l.sales * x) / l.qty) : 0;
        const deduction = Math.round(perUnitDed * x);
        const amount = diff < 0 ? -(sales - deduction) : sales - deduction;
        const reason = diff < 0
          ? `${orderNumber} — «${name}» ${x} ширхэгийг ${date}-ны тооцоог шилжүүлсний дараа буцаасан (цуцалсан эсвэл үйлчлүүлэгч аваагүй). Тэр үед олгосон ${money(sales)} борлуулалтаас суутгал ${money(deduction)}-ийг хасаад ${money(sales - deduction)} буцааж тооцно.`
          : `${orderNumber} — «${name}» ${x} ширхэг ${date}-ны тооцоог шилжүүлсний дараа хүргэгдсэн тул нэмж олгоно: борлуулалт ${money(sales)} − суутгал ${money(deduction)}.`;
        await tx.supplierAdjustment.create({
          data: { shopId, kind: diff < 0 ? 'REFUND' : 'ADDITION', sourceDayId: day.id, sourceDate: day.date, orderNumber, productId: pid, productName: name, qty: x, sales, deduction, amount, reason },
        });
        if (item) await tx.supplierDayItem.update({ where: { id: item.id }, data: { adjustedQty: { increment: -diff } } });
        else await tx.supplierDayItem.create({ data: { dayId: day.id, source: l!.source, orderNumber, productId: pid, qty: 0, sales: 0, deduction: 0, adjustedQty: -diff } });
        await writeAudit({ id: null, name: 'СИСТЕМ' }, diff < 0 ? 'supplier.refund' : 'supplier.addition', 'SupplierShop', String(shopId), { date, orderNumber, product: name, qty: x, amount }, tx);
        created++;
      }
    }
    return created;
  }, { timeout: 30_000 });
}

// ───────────── Харах ─────────────

async function shopOf(actor: UserActor, shopIdIn: unknown) {
  if (canEdit(actor.roles, 'supplier')) {
    const shop = await db.supplierShop.findUnique({ where: { id: shopIdOf(shopIdIn) } });
    if (!shop) throw notFound('Дэлгүүр олдсонгүй');
    return shop;
  }
  if (!canView(actor.roles, 'supplier')) throw forbidden();
  const shop = await db.supplierShop.findUnique({ where: { userId: actor.id } });
  if (!shop || !shop.isActive) throw notFound('Таны дэлгүүр бүртгэгдээгүй байна — админд хандана уу');
  return shop;
}

async function pendingAdjustments(tx: Tx | typeof db, shopId: number) {
  const list = await tx.supplierAdjustment.findMany({ where: { shopId, appliedDayId: null }, orderBy: { id: 'asc' } });
  return list.map((a) => adjView(a, new Map()));
}

/** Нэг өдрийн тооцоо. Шилжүүлсэн бол хуулбар (түгжигдсэн) */
export async function dayView(actor: UserActor, shopIdIn: unknown, dateIn: unknown): Promise<DayCalc> {
  const shop = await shopOf(actor, shopIdIn);
  const date = cleanDate(dateIn);
  await syncAdjustments(shop.id);
  return computeDayTx(db, shop.id, date);
}

async function computeDayTx(tx: Tx | typeof db, shopId: number, date: string): Promise<DayCalc> {
  const row = await tx.supplierDay.findUnique({ where: { shopId_date: { shopId, date: dateOnly(date) } } });
  if (row?.status === DONE && row.snapshot) {
    const snap = row.snapshot as unknown as DayCalc;
    const applied = await tx.supplierAdjustment.findMany({ where: { appliedDayId: row.id }, orderBy: { id: 'asc' } });
    const later = await tx.supplierAdjustment.findMany({ where: { sourceDayId: row.id, kind: { not: 'CARRY' } }, orderBy: { id: 'asc' } });
    const ad = new Map(await appliedDateMap(tx, later));
    return { ...snap, status: DONE, adjustments: applied.map((a) => adjView(a, new Map())), laterChanges: later.map((a) => adjView(a, ad)), transferredAt: row.transferredAt, transferredByName: row.transferredByName, version: row.version };
  }
  const live = (await computeLive(tx, shopId, date, date, row ? [row] : [])).get(date) ?? { lines: [], unfinished: 0, items: [] };
  const adjustments = await pendingAdjustments(tx, shopId);
  const totals = totalsOf(live.lines);
  const adjTotal = adjustments.reduce((a, x) => a + x.amount, 0);
  const raw = totals.net + adjTotal;
  return { shopId, date, status: OPEN, lines: live.lines, totals, unfinished: live.unfinished, adjustments, adjTotal,
    payable: Math.max(0, raw), carry: Math.min(0, raw), transferredAt: null, transferredByName: null, version: row?.version ?? 0 };
}

async function appliedDateMap(tx: Tx | typeof db, adj: { appliedDayId: number | null }[]) {
  const ids = [...new Set(adj.flatMap((a) => (a.appliedDayId ? [a.appliedDayId] : [])))];
  if (!ids.length) return [] as [number, string][];
  const ds = await tx.supplierDay.findMany({ where: { id: { in: ids } }, select: { id: true, date: true } });
  return ds.map((d) => [d.id, ymdOf(d.date)] as [number, string]);
}

export interface RangeDay { date: string; status: 'OPEN' | 'TRANSFERRED'; qty: number; sales: number; deductions: number; net: number; adjustments: number; payable: number; unfinished: number }

async function rangeDays(tx: Tx | typeof db, shopId: number, from: string, to: string): Promise<RangeDay[]> {
  const rows = await tx.supplierDay.findMany({ where: { shopId, date: { gte: dateOnly(from), lte: dateOnly(to) } } });
  const done = new Map(rows.filter((r) => r.status === DONE).map((r) => [ymdOf(r.date), r]));
  const live = await computeLive(tx, shopId, from, to, rows.filter((r) => r.status !== DONE));
  const out: RangeDay[] = [];
  for (const [date, r] of done) {
    const snap = r.snapshot as unknown as DayCalc | null;
    out.push({ date, status: DONE, qty: snap?.totals.qty ?? 0, sales: r.sales, deductions: r.deductions, net: r.net, adjustments: r.adjustments, payable: r.payable, unfinished: 0 });
  }
  for (const [date, d] of live) {
    if (done.has(date)) continue;
    const t = totalsOf(d.lines);
    if (t.qty === 0 && d.unfinished === 0 && t.cancelledQty === 0) continue;
    out.push({ date, status: OPEN, qty: t.qty, sales: t.sales, deductions: t.deductions, net: t.net, adjustments: 0, payable: Math.max(0, t.net), unfinished: d.unfinished });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

/** Нэгтгэл: огнооны хүрээгээр (хамгийн ихдээ 93 хоног) */
export async function rangeSummary(actor: UserActor, shopIdIn: unknown, fromIn: unknown, toIn: unknown) {
  const shop = await shopOf(actor, shopIdIn);
  const from = cleanDate(fromIn, 'Эхлэх огноо');
  const to = cleanDate(toIn, 'Дуусах огноо');
  if (from > to) throw badRequest('Эхлэх огноо дуусахаас хойш байна');
  if (Date.parse(to) - Date.parse(from) > MAX_RANGE * 86_400_000) throw badRequest(`Хамгийн ихдээ ${MAX_RANGE} хоног сонгоно уу`);
  const days = await rangeDays(db, shop.id, from, to);
  const sum = (k: keyof RangeDay) => days.reduce((a, d) => a + (d[k] as number), 0);
  return {
    from, to, days,
    totals: { qty: sum('qty'), sales: sum('sales'), deductions: sum('deductions'), net: sum('net'),
      transferred: days.filter((d) => d.status === DONE).reduce((a, d) => a + d.payable, 0),
      notTransferred: days.filter((d) => d.status === OPEN).reduce((a, d) => a + d.net, 0), daysWithData: days.length },
  };
}

/**
 * «Өнөөдөр / Өчигдөр / Уржигдар» захиалга (#102): захиалгын «өдөр» = баталгаажсан мөч (энгийн — үүссэн, урьдчилж төлсөн — мөнгө орсон; хуучин шиг),
 * Улаанбаатарын 00:00-аас. Тоолохгүй: «Төлбөр хүлээж буй», «Шинэ» байгаад (жолоочид гараагүй) цуцлагдсан, он сар өдөртэй.
 * shopId = null → компанийн нийт (дүн = захиалгын нийт дүн) + нийлүүлэгч тус бүр; shopId → зөвхөн тэр нийлүүлэгчийн бараатай (дүн = түүний бараа).
 */
export interface OrderDay { label: string; date: string; total: number; delivered: number; cancelled: number; onRoad: number; pending: number; amount: number; shops?: { id: number; name: string; total: number; amount: number }[] }
async function orderStats(tx: Tx | typeof db, shopId: number | null, shops: { id: number; name: string }[] = []): Promise<OrderDay[]> {
  const today = ubDay();
  const labels = ['Өнөөдөр', 'Өчигдөр', 'Уржигдар'];
  const out: OrderDay[] = [];
  for (let i = 0; i < 3; i++) {
    const d = addDays(today, -i);
    const t0 = ubDayStart(d); const t1 = ubDayStart(addDays(d, 1));
    const counted = Prisma.sql`o."confirmedAt" >= ${t0} AND o."confirmedAt" < ${t1} AND o.status <> 'PENDING_PAYMENT'
      AND NOT (o.status = 'CANCELLED' AND o."outForDeliveryAt" IS NULL) AND o."deliveryDate" <= ${dateOnly(addDays(d, 1))}::date`;
    const amountSql = shopId === null
      ? Prisma.sql`o.total`
      : Prisma.sql`(SELECT sum(l.qty * l."unitPrice") FROM "OrderLine" l JOIN "SupplierProduct" a ON a."productId" = l."productId" AND a."shopId" = ${shopId} AND a."fromDate" <= ${dateOnly(d)}::date AND (a."toDate" IS NULL OR a."toDate" > ${dateOnly(d)}::date) WHERE l."orderId" = o.id)`;
    const [r] = await tx.$queryRaw<Omit<OrderDay, 'label' | 'date'>[]>`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE x.status = 'DELIVERED')::int AS delivered,
             count(*) FILTER (WHERE x.status = 'CANCELLED')::int AS cancelled,
             count(*) FILTER (WHERE x.status IN ('ASSIGNED', 'OUT_FOR_DELIVERY'))::int AS "onRoad",
             count(*) FILTER (WHERE x.status = 'NEW')::int AS pending,
             coalesce(sum(x.amount), 0)::int AS amount
      FROM (SELECT o.status, ${amountSql} AS amount FROM "Order" o WHERE ${counted}) x
      ${shopId === null ? Prisma.empty : Prisma.sql`WHERE x.amount IS NOT NULL`}`;
    const day: OrderDay = { label: labels[i]!, date: d, ...r! };
    if (shopId === null && shops.length) {
      const per = await tx.$queryRaw<{ shopId: number; total: number; amount: number }[]>`
        SELECT a."shopId", count(DISTINCT o.id)::int AS total, coalesce(sum(l.qty * l."unitPrice"), 0)::int AS amount
        FROM "Order" o JOIN "OrderLine" l ON l."orderId" = o.id
        JOIN "SupplierProduct" a ON a."productId" = l."productId" AND a."fromDate" <= ${dateOnly(d)}::date AND (a."toDate" IS NULL OR a."toDate" > ${dateOnly(d)}::date)
        WHERE ${counted} AND a."shopId" = ANY(${shops.map((x) => x.id)}::int[])
        GROUP BY 1`;
      const m = new Map(per.map((x) => [x.shopId, x]));
      day.shops = shops.map((x) => ({ id: x.id, name: x.name, total: m.get(x.id)?.total ?? 0, amount: m.get(x.id)?.amount ?? 0 }));
    }
    out.push(day);
  }
  return out;
}

/** Нийлүүлэгчийн «төлөх үлдэгдэл»: сүүлийн 90 хоногийн шилжүүлээгүй өдрүүд + хасагдаагүй буцаалт/нэмэгдэл */
async function balanceOf(tx: Tx | typeof db, shopId: number) {
  const today = ubDay();
  const days = await rangeDays(tx, shopId, addDays(today, -SYNC_DAYS), today);
  const open = days.filter((d) => d.status === OPEN);
  const adj = await tx.supplierAdjustment.aggregate({ where: { shopId, appliedDayId: null }, _sum: { amount: true }, _count: true });
  const openNet = open.reduce((a, d) => a + d.net, 0);
  return { openDays: open.length, openNet, pendingAdj: adj._sum.amount ?? 0, pendingAdjCount: adj._count, balance: openNet + (adj._sum.amount ?? 0), days };
}

/** Удирдлагын самбар + дэлгүүрийн жагсаалт */
export async function overview(actor: UserActor) {
  assertAdmin(actor);
  const shops = await db.supplierShop.findMany({ orderBy: [{ isActive: 'desc' }, { name: 'asc' }] });
  const counts = await db.supplierProduct.groupBy({ by: ['shopId'], where: { toDate: null }, _count: true });
  const cnt = new Map(counts.map((c) => [c.shopId, c._count]));
  const today = ubDay();
  const monthStart = `${today.slice(0, 7)}-01`;
  let monthSales = 0, monthNet = 0, todaySales = 0, todayNet = 0, balance = 0;
  const rows = [];
  for (const s of shops) {
    if (s.isActive) await syncAdjustments(s.id);
    const b = s.isActive ? await balanceOf(db, s.id) : null;
    const month = b ? b.days.filter((d) => d.date >= monthStart) : [];
    const td = month.find((d) => d.date === today);
    if (s.isActive) {
      monthSales += month.reduce((a, d) => a + d.sales, 0); monthNet += month.reduce((a, d) => a + d.net, 0);
      todaySales += td?.sales ?? 0; todayNet += td?.net ?? 0; balance += b!.balance;
    }
    rows.push({ id: s.id, name: s.name, contactName: s.contactName, contactPhone: s.contactPhone, isActive: s.isActive, hasLogin: !!s.userId,
      productCount: cnt.get(s.id) ?? 0, openDays: b?.openDays ?? 0, balance: b?.balance ?? 0, pendingAdj: b?.pendingAdj ?? 0, monthSales: month.reduce((a, d) => a + d.sales, 0) });
  }
  return {
    stats: { activeShops: shops.filter((s) => s.isActive).length, monthSales, monthNet, todaySales, todayNet, balance },
    orderDays: await orderStats(db, null, shops.filter((s) => s.isActive).map((s) => ({ id: s.id, name: s.name }))),
    shops: rows, isSuperAdmin: isSA(actor), today, defaults: await getDefaults(db),
  };
}

/** Дэлгүүрийн дэлгэрэнгүй (удирдлага) эсвэл нийлүүлэгчийн өөрийн самбар */
export async function shopDetail(actor: UserActor, shopIdIn?: unknown) {
  const shop = await shopOf(actor, shopIdIn);
  await syncAdjustments(shop.id);
  const admin = canEdit(actor.roles, 'supplier');
  const [assignments, deds, b, adjAll, login] = await Promise.all([
    db.supplierProduct.findMany({ where: { shopId: shop.id }, orderBy: [{ toDate: { sort: 'asc', nulls: 'first' } }, { id: 'desc' }] }),
    db.supplierDeduction.findMany({ where: { shopId: shop.id } }),
    balanceOf(db, shop.id),
    db.supplierAdjustment.findMany({ where: { shopId: shop.id, kind: { not: 'CARRY' } }, orderBy: { id: 'desc' }, take: 200 }),
    admin && shop.userId ? db.user.findUnique({ where: { id: shop.userId }, select: { id: true, name: true, phone: true, isActive: true, lastLoginAt: true } }) : null,
  ]);
  const info = await productInfo(db, [...new Set(assignments.map((a) => a.productId))]);
  const ded = new Map(deds.map((d) => [d.productId, d]));
  const ad = new Map(await appliedDateMap(db, adjAll));
  return {
    shop: { id: shop.id, name: shop.name, contactName: shop.contactName, contactPhone: shop.contactPhone, isActive: shop.isActive, version: shop.version },
    admin, isSuperAdmin: isSA(actor), today: ubDay(), defaults: admin ? await getDefaults(db) : null,
    products: assignments.map((a) => {
      const d = ded.get(a.productId);
      return { id: a.id, productId: a.productId, code: info.get(a.productId)?.code ?? '', name: info.get(a.productId)?.name ?? '', fromDate: ymdOf(a.fromDate), toDate: a.toDate ? ymdOf(a.toDate) : null,
        active: !a.toDate || ymdOf(a.toDate) > ubDay(), createdByName: a.createdByName, endedByName: a.endedByName,
        deduction: { operatorCost: d?.operatorCost ?? 0, deliveryCost: d?.deliveryCost ?? 0, marketingCost: d?.marketingCost ?? 0, otherCost: d?.otherCost ?? 0, otherNote: d?.otherNote ?? '' } };
    }),
    balance: { openDays: b.openDays, openNet: b.openNet, pendingAdj: b.pendingAdj, pendingAdjCount: b.pendingAdjCount, balance: b.balance },
    openDays: b.days.filter((d) => d.status === OPEN),
    transferredDays: b.days.filter((d) => d.status === DONE),
    adjustments: adjAll.map((a) => adjView(a, ad)),
    orderDays: await orderStats(db, shop.id),
    login,
  };
}

// ───────────── Удирдлага: дэлгүүр, бараа, суутгал ─────────────

export async function saveShop(actor: UserActor, b: { id?: unknown; name?: unknown; contactName?: unknown; contactPhone?: unknown; version?: unknown }) {
  assertAdmin(actor);
  const name = cleanText(b.name, 120);
  if (name.length < 2) throw badRequest('Дэлгүүрийн нэр бичнэ үү');
  const data = { name, contactName: cleanText(b.contactName, 120), contactPhone: cleanText(b.contactPhone, 40) };
  try {
    if (b.id) {
      const id = shopIdOf(b.id);
      const r = await db.$transaction(async (tx) => {
        const n = await tx.supplierShop.updateMany({ where: { id, version: Number(b.version) }, data: { ...data, version: { increment: 1 } } });
        if (!n.count) throw conflict('Өөр хүн өөрчилсөн байна — дахин нээнэ үү', 'stale');
        await writeAudit(actor, 'supplier.shop_updated', 'SupplierShop', String(id), data, tx);
        return { id };
      });
      return r;
    }
    return await db.$transaction(async (tx) => {
      const s = await tx.supplierShop.create({ data });
      await writeAudit(actor, 'supplier.shop_created', 'SupplierShop', String(s.id), data, tx);
      return { id: s.id };
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('Ийм нэртэй дэлгүүр бүртгэлтэй байна');
    throw e;
  }
}

export async function setShopActive(actor: UserActor, idIn: unknown, active: unknown) {
  assertAdmin(actor);
  const id = shopIdOf(idIn);
  const isActive = active !== false;
  await db.$transaction(async (tx) => {
    const s = await tx.supplierShop.update({ where: { id }, data: { isActive, version: { increment: 1 } } }).catch(() => { throw notFound('Дэлгүүр олдсонгүй'); });
    if (s.userId) await tx.user.update({ where: { id: s.userId }, data: { isActive } });
    if (!isActive && s.userId) await tx.session.deleteMany({ where: { userId: s.userId } });
    await writeAudit(actor, isActive ? 'supplier.shop_activated' : 'supplier.shop_deactivated', 'SupplierShop', String(id), {}, tx);
  });
  return { ok: true };
}

/** Бараа хайх (хувиарлах) — аль дэлгүүрт оноогдсоныг харуулна */
export async function searchProducts(actor: UserActor, qIn: unknown) {
  assertAdmin(actor);
  const q = cleanText(qIn, 60);
  const ps = await db.product.findMany({
    where: { status: { not: 'ARCHIVED' }, ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { code: { contains: q, mode: 'insensitive' } }] } : {}) },
    select: { id: true, code: true, name: true, price: true }, orderBy: { name: 'asc' }, take: 30,
  });
  const open = await db.supplierProduct.findMany({ where: { productId: { in: ps.map((p) => p.id) }, toDate: null }, include: { shop: { select: { id: true, name: true } } } });
  const om = new Map(open.map((o) => [o.productId, o.shop]));
  return ps.map((p) => ({ ...p, shop: om.get(p.id) ?? null }));
}

export async function assignProduct(actor: UserActor, b: { shopId?: unknown; productId?: unknown; fromDate?: unknown }) {
  assertAdmin(actor);
  const shopId = shopIdOf(b.shopId);
  const productId = Number(b.productId);
  if (!Number.isInteger(productId) || productId <= 0) throw badRequest('Бараа сонгоно уу');
  const fromDate = b.fromDate ? cleanDate(b.fromDate, 'Эхлэх огноо') : ubDay();
  try {
    return await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(7301, ${productId}::int)`;
      const [shop, product] = await Promise.all([tx.supplierShop.findUnique({ where: { id: shopId } }), tx.product.findUnique({ where: { id: productId }, select: { id: true, code: true, name: true } })]);
      if (!shop) throw notFound('Дэлгүүр олдсонгүй');
      if (!product) throw notFound('Бараа олдсонгүй');
      const open = await tx.supplierProduct.findFirst({ where: { productId, toDate: null }, include: { shop: { select: { name: true } } } });
      if (open) {
        throw conflict(open.shopId === shopId
          ? 'Энэ бараа энэ дэлгүүрт аль хэдийн оноогдсон байна'
          : `Энэ бараа «${open.shop.name}» дэлгүүрт оноогдсон байна. Нэг барааг 2 нийлүүлэгчид давхар төлөхгүйн тулд эхлээд тэндээс хасна уу.`, 'already_assigned');
      }
      const last = await tx.supplierProduct.findFirst({ where: { productId }, orderBy: { toDate: 'desc' } });
      if (last?.toDate && fromDate < ymdOf(last.toDate)) {
        throw badRequest(`Энэ бараа ${ymdOf(last.toDate)}-ны өмнө өөр дэлгүүрт хамаарч байсан тул эхлэх огноо ${ymdOf(last.toDate)}-аас хойш байна`);
      }
      const a = await tx.supplierProduct.create({ data: { shopId, productId, fromDate: dateOnly(fromDate), createdByName: actor.name } });
      // Анхдагч суутгал автоматаар (#100) — өмнө тохируулсан бол хэвээр
      if (!(await tx.supplierDeduction.findUnique({ where: { shopId_productId: { shopId, productId } } }))) {
        const def = await getDefaults(tx);
        await tx.supplierDeduction.create({ data: { shopId, productId, ...def, updatedByName: `${actor.name} (анхдагч)` } });
      }
      await writeAudit(actor, 'supplier.product_assigned', 'SupplierShop', String(shopId), { product: `${product.code} ${product.name}`, fromDate }, tx);
      return { id: a.id };
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('Энэ бараа өөр дэлгүүрт оноогдсон байна', 'already_assigned');
    throw e;
  }
}

/** Хасах — өнөөдрийн падаан хуучин дэлгүүрт тооцогдоно, маргаашаас хамаарахгүй */
export async function unassignProduct(actor: UserActor, idIn: unknown) {
  assertAdmin(actor);
  const id = Number(idIn);
  return db.$transaction(async (tx) => {
    const a = await tx.supplierProduct.findUnique({ where: { id } });
    if (!a || a.toDate) throw notFound('Хувиарлалт олдсонгүй');
    const tomorrow = addDays(ubDay(), 1);
    const from = ymdOf(a.fromDate);
    const to = from > tomorrow ? from : tomorrow;
    await tx.supplierProduct.update({ where: { id }, data: { toDate: dateOnly(to), endedByName: actor.name } });
    const p = await tx.product.findUnique({ where: { id: a.productId }, select: { code: true, name: true } });
    await writeAudit(actor, 'supplier.product_unassigned', 'SupplierShop', String(a.shopId), { product: `${p?.code} ${p?.name}`, until: to }, tx);
    return { ok: true, until: to };
  });
}

export async function saveDeduction(actor: UserActor, b: Record<string, unknown>) {
  assertSA(actor);
  const shopId = shopIdOf(b.shopId);
  const productId = Number(b.productId);
  const has = await db.supplierProduct.findFirst({ where: { shopId, productId } });
  if (!has) throw badRequest('Энэ бараа энэ дэлгүүрт хувиарлагдаагүй');
  const data = {
    operatorCost: cleanInt(b.operatorCost, 'Опп зардал', 10_000_000), deliveryCost: cleanInt(b.deliveryCost, 'Хүргэлт', 10_000_000),
    marketingCost: cleanInt(b.marketingCost, 'Маркетинг', 10_000_000), otherCost: cleanInt(b.otherCost, 'Бусад', 10_000_000), otherNote: cleanText(b.otherNote, 200),
  };
  await db.$transaction(async (tx) => {
    const old = await tx.supplierDeduction.findUnique({ where: { shopId_productId: { shopId, productId } } });
    await tx.supplierDeduction.upsert({ where: { shopId_productId: { shopId, productId } }, create: { shopId, productId, ...data, updatedByName: actor.name }, update: { ...data, updatedByName: actor.name } });
    await writeAudit(actor, 'supplier.deduction_saved', 'SupplierShop', String(shopId), { productId, before: old ? { operatorCost: old.operatorCost, deliveryCost: old.deliveryCost, marketingCost: old.marketingCost, otherCost: old.otherCost } : null, after: data }, tx);
  });
  return { ok: true };
}

// ───────────── Анхдагч суутгал (#100): бүх дэлгүүрт нэг, бараа нэмэхэд автоматаар ─────────────
const KEY_DEFAULT = 'supplier.defaultDeduction';
export type DefaultDeduction = { operatorCost: number; deliveryCost: number; marketingCost: number; otherCost: number; otherNote: string };
export async function getDefaults(tx: Tx | typeof db): Promise<DefaultDeduction> {
  const r = await tx.appSetting.findUnique({ where: { key: KEY_DEFAULT } });
  const v = (r?.value ?? {}) as Partial<DefaultDeduction>;
  return { operatorCost: v.operatorCost ?? 0, deliveryCost: v.deliveryCost ?? 0, marketingCost: v.marketingCost ?? 0, otherCost: v.otherCost ?? 0, otherNote: v.otherNote ?? '' };
}

/** Анхдагч суутгал — зөвхөн Супер админ. applyAll: одоо оноогдсон бүх барааны суутгалыг ч шинэчилнэ (шилжүүлсэн өдөр өөрчлөгдөхгүй) */
export async function setDefaults(actor: UserActor, b: Record<string, unknown>) {
  assertSA(actor);
  const v: DefaultDeduction = {
    operatorCost: cleanInt(b.operatorCost, 'Опп зардал', 10_000_000), deliveryCost: cleanInt(b.deliveryCost, 'Хүргэлт', 10_000_000),
    marketingCost: cleanInt(b.marketingCost, 'Маркетинг', 10_000_000), otherCost: cleanInt(b.otherCost, 'Бусад', 10_000_000), otherNote: cleanText(b.otherNote, 200),
  };
  const applyAll = b.applyAll === true;
  return db.$transaction(async (tx) => {
    const before = await getDefaults(tx);
    const json = v as unknown as Prisma.InputJsonValue;
    await tx.appSetting.upsert({ where: { key: KEY_DEFAULT }, create: { key: KEY_DEFAULT, value: json, updatedById: actor.id }, update: { value: json, updatedById: actor.id } });
    let updated = 0;
    if (applyAll) {
      const tomorrow = dateOnly(addDays(ubDay(), 1));
      const act = await tx.supplierProduct.findMany({ where: { OR: [{ toDate: null }, { toDate: { gte: tomorrow } }] }, select: { shopId: true, productId: true } });
      const seen = new Set<string>();
      for (const a of act) {
        const k = `${a.shopId}:${a.productId}`; if (seen.has(k)) continue; seen.add(k);
        await tx.supplierDeduction.upsert({ where: { shopId_productId: { shopId: a.shopId, productId: a.productId } }, create: { ...a, ...v, updatedByName: actor.name }, update: { ...v, updatedByName: actor.name } });
        updated++;
      }
    }
    await writeAudit(actor, 'supplier.default_deduction', 'AppSetting', KEY_DEFAULT, { before, after: v, applyAll, updated } as unknown as Prisma.InputJsonValue, tx, ['money']);
    return { ok: true, updated };
  });
}

/** Тухайн өдрийн суутгалыг гараар засах — ЗӨВХӨН Супер админ (#98); шилжүүлсэн өдөрт болохгүй */
export async function overrideDay(actor: UserActor, b: Record<string, unknown>) {
  if (!isSA(actor)) throw forbidden('Суутгалыг гараар зөвхөн Супер админ засна');
  const shopId = shopIdOf(b.shopId);
  const date = cleanDate(b.date);
  const productId = Number(b.productId);
  if (!Number.isInteger(productId)) throw badRequest('Бараа буруу');
  const clear = b.clear === true;
  const ov: Override | null = clear ? null : {
    operatorCost: cleanInt(b.operatorCost, 'Опп зардал'), deliveryCost: cleanInt(b.deliveryCost, 'Хүргэлт'),
    marketingCost: cleanInt(b.marketingCost, 'Маркетинг'), otherCost: cleanInt(b.otherCost, 'Бусад'), note: cleanText(b.note, 200),
  };
  return db.$transaction(async (tx) => {
    await lockShop(tx, shopId);
    const row = await tx.supplierDay.findUnique({ where: { shopId_date: { shopId, date: dateOnly(date) } } });
    if (row?.status === DONE) throw new AppError(423, 'Шилжүүлсэн өдрийг засахгүй (түгжигдсэн)', 'locked');
    if (row && b.version !== undefined && Number(b.version) !== row.version) throw conflict('Өөр хүн өөрчилсөн байна — дахин ачаална уу', 'stale');
    const before = await computeDayTx(tx, shopId, date);
    const line = before.lines.find((l) => l.productId === productId);
    if (!line) throw badRequest('Энэ өдөр энэ бараа зарагдаагүй');
    const overrides = { ...((row?.overrides ?? {}) as Record<string, Override>) };
    if (ov) overrides[String(productId)] = ov; else delete overrides[String(productId)];
    const json = overrides as unknown as Prisma.InputJsonValue;
    if (row) await tx.supplierDay.update({ where: { id: row.id }, data: { overrides: json, version: { increment: 1 } } });
    else await tx.supplierDay.create({ data: { shopId, date: dateOnly(date), overrides: json } });
    await writeAudit(actor, 'supplier.deduction_override', 'SupplierShop', String(shopId), {
      date, product: `${line.code} ${line.name}`,
      before: { operatorCost: line.operatorCost, deliveryCost: line.deliveryCost, marketingCost: line.marketingCost, otherCost: line.otherCost },
      after: ov ?? 'тохиргоогоор', note: ov?.note ?? null,
    }, tx, ['money']);
    return { ok: true };
  });
}

/** «Шилжүүлсэн» — өдөр түгжигдэнэ; хүлээгдэж буй буцаалт/нэмэгдэл энэ шилжүүлэгт тооцогдоно */
export async function transferDay(actor: UserActor, b: Record<string, unknown>) {
  assertAdmin(actor);
  const shopId = shopIdOf(b.shopId);
  const date = cleanDate(b.date);
  if (date > ubDay()) throw badRequest('Ирээдүйн өдрийг шилжүүлэхгүй');
  await syncAdjustments(shopId);
  return db.$transaction(async (tx) => {
    await lockShop(tx, shopId);
    const row = await tx.supplierDay.findUnique({ where: { shopId_date: { shopId, date: dateOnly(date) } } });
    if (row?.status === DONE) throw conflict('Энэ өдөр аль хэдийн шилжүүлсэн', 'already_transferred');
    if (row && b.version !== undefined && Number(b.version) !== row.version) throw conflict('Өөр хүн өөрчилсөн байна — дахин ачаална уу', 'stale');
    const calc = await computeDayTx(tx, shopId, date);
    if (calc.unfinished > 0) throw badRequest(`Энэ падааны ${calc.unfinished} захиалга дуусаагүй байна (хүргэлтэд эсвэл хүлээн аваагүй). Бүгд дууссаны дараа шилжүүлнэ.`, 'unfinished');
    if (calc.lines.length === 0 && calc.adjustments.length === 0) throw badRequest('Энэ өдөр шилжүүлэх зүйл алга');
    const live = (await computeLive(tx, shopId, date, date, row ? [row] : [])).get(date);
    const raw = calc.totals.net + calc.adjTotal;
    const payable = Math.max(0, raw);
    const day = row
      ? await tx.supplierDay.update({ where: { id: row.id }, data: { status: DONE } })
      : await tx.supplierDay.create({ data: { shopId, date: dateOnly(date), status: DONE } });
    // Захиалга бүрт ногдох суутгал (мөрийн нийт суутгалыг тоогоор хувааж, нийлбэр яг тэнцэнэ)
    const byProduct = new Map<number, LiveItem[]>();
    for (const i of live?.items ?? []) { const a = byProduct.get(i.productId) ?? []; a.push(i); byProduct.set(i.productId, a); }
    for (const l of calc.lines) {
      const list = byProduct.get(l.productId) ?? [];
      let left = l.deduction;
      list.forEach((i, idx) => {
        const share = idx === list.length - 1 ? left : Math.round((l.deduction * i.qty) / (l.qty || 1));
        left -= share;
        (i as LiveItem & { deduction: number }).deduction = share;
      });
    }
    const items = (live?.items ?? []).map((i) => ({ dayId: day.id, source: i.source, orderNumber: i.orderNumber, productId: i.productId, qty: i.qty, sales: i.sales, deduction: (i as LiveItem & { deduction?: number }).deduction ?? 0 }));
    if (items.length) await tx.supplierDayItem.createMany({ data: items });
    if (calc.adjustments.length) await tx.supplierAdjustment.updateMany({ where: { id: { in: calc.adjustments.map((a) => a.id) }, appliedDayId: null }, data: { appliedDayId: day.id } });
    if (raw < 0) {
      await tx.supplierAdjustment.create({ data: { shopId, kind: 'CARRY', sourceDayId: day.id, sourceDate: dateOnly(date), amount: raw,
        reason: `${date}-ны шилжүүлэгт багтаагүй хасалт ${money(-raw)} — дараагийн шилжүүлгээс хасагдана` } });
    }
    const snapshot = { ...calc, status: DONE, payable, carry: Math.min(0, raw) } as unknown as Prisma.InputJsonValue;
    const now = new Date();
    await tx.supplierDay.update({ where: { id: day.id }, data: {
      snapshot, sales: calc.totals.sales, deductions: calc.totals.deductions, net: calc.totals.net, adjustments: calc.adjTotal, payable,
      transferredAt: now, transferredByName: actor.name, version: { increment: 1 } } });
    await writeAudit(actor, 'supplier.transferred', 'SupplierShop', String(shopId), { date, sales: calc.totals.sales, deductions: calc.totals.deductions, net: calc.totals.net, adjustments: calc.adjTotal, payable }, tx, ['money']);
    return { ok: true, payable };
  }, { timeout: 30_000 });
}

/** «Шилжүүлсэн»-ийг буцаах — зөвхөн Супер админ, зөвхөн хамгийн сүүлд шилжүүлсэн өдөр (дараагийнх нь хөндөгдөхгүй) */
export async function undoTransfer(actor: UserActor, b: Record<string, unknown>) {
  if (!isSA(actor)) throw forbidden('Шилжүүлсэн тооцоог зөвхөн Супер админ буцаана');
  const shopId = shopIdOf(b.shopId);
  const date = cleanDate(b.date);
  return db.$transaction(async (tx) => {
    await lockShop(tx, shopId);
    const row = await tx.supplierDay.findUnique({ where: { shopId_date: { shopId, date: dateOnly(date) } } });
    if (!row || row.status !== DONE) throw notFound('Шилжүүлсэн тооцоо олдсонгүй');
    const later = await tx.supplierDay.findFirst({ where: { shopId, status: DONE, transferredAt: { gt: row.transferredAt ?? new Date(0) } } });
    if (later) throw badRequest(`Хойно нь ${ymdOf(later.date)}-ны тооцоо шилжүүлсэн тул зөвхөн хамгийн сүүлийнхийг буцаана`);
    const usedLater = await tx.supplierAdjustment.findFirst({ where: { sourceDayId: row.id, appliedDayId: { not: null } } });
    if (usedLater) throw badRequest('Энэ өдрөөс үүссэн буцаалт дараагийн шилжүүлэгт тооцогдсон тул буцаахгүй');
    await tx.supplierAdjustment.deleteMany({ where: { sourceDayId: row.id } });
    await tx.supplierAdjustment.updateMany({ where: { appliedDayId: row.id }, data: { appliedDayId: null } });
    await tx.supplierDayItem.deleteMany({ where: { dayId: row.id } });
    await tx.supplierDay.update({ where: { id: row.id }, data: { status: OPEN, snapshot: Prisma.DbNull, sales: 0, deductions: 0, net: 0, adjustments: 0, payable: 0, transferredAt: null, transferredByName: null, version: { increment: 1 } } });
    await writeAudit(actor, 'supplier.transfer_undone', 'SupplierShop', String(shopId), { date, payable: row.payable }, tx, ['money']);
    return { ok: true };
  });
}

// ───────────── Нэвтрэх эрх ─────────────

export async function createLogin(actor: UserActor, b: { shopId?: unknown; name?: unknown; phone?: unknown }) {
  assertAdmin(actor);
  const shopId = shopIdOf(b.shopId);
  const shop = await db.supplierShop.findUnique({ where: { id: shopId } });
  if (!shop) throw notFound('Дэлгүүр олдсонгүй');
  if (shop.userId) throw conflict('Нэвтрэх эрх аль хэдийн үүссэн');
  const r = await createUser(actor, { name: b.name || shop.contactName || shop.name, phone: b.phone, roles: ['SUPPLIER'] });
  await db.$transaction(async (tx) => {
    await tx.supplierShop.update({ where: { id: shopId }, data: { userId: r.user.id, version: { increment: 1 } } });
    await writeAudit(actor, 'supplier.login_created', 'SupplierShop', String(shopId), { phone: r.user.phone }, tx);
  });
  return { phone: r.user.phone, temporaryPassword: r.temporaryPassword };
}

export async function resetLogin(actor: UserActor, b: { shopId?: unknown }) {
  assertAdmin(actor);
  const shop = await db.supplierShop.findUnique({ where: { id: shopIdOf(b.shopId) } });
  if (!shop?.userId) throw notFound('Нэвтрэх эрх үүсээгүй');
  const r = await resetPassword(actor, shop.userId);
  return { temporaryPassword: r.temporaryPassword };
}

/** Нийлүүлэгч өөрөө: өөрийн дэлгүүрийн дугаар */
export async function myShopId(actor: UserActor) {
  const shop = await shopOf(actor, null);
  return shop.id;
}
