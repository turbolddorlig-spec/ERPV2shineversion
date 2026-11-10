import { Prisma, type MoveType } from '@prisma/client';
import { db } from '../../db';
import { badRequest, notFound } from '../../errors';
import { writeAudit } from '../../audit';
import { canApproveStock, canOperateStock, canView } from '../../permissions';
import { MOVE_LABEL, cleanId, requireRole, stockCache, transitLocationId, type UserActor } from './core';
import { variantInfo } from './info';

export const STOCK_PAGE_SIZE = 50;
export const MOVE_PAGE_SIZE = 50;

async function warehousesWithLoc() {
  const ws = await db.warehouse.findMany({ where: { isActive: true }, orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }, { id: 'asc' }], include: { location: true } });
  return ws.map((w) => ({ id: w.id, name: w.name, isPrimary: w.isPrimary, locationId: w.location!.id }));
}

/** Хувилбар бүрийн байршлын үлдэгдэл: агуулах тус бүр, замдаа, ажилтны гарт, жолоочийн гарт, захиалгад */
export async function balancesFor(variantIds: number[]) {
  const out = new Map<number, { byLocation: Map<number, number>; transit: number; staff: number; driver: number; warehouses: number; reserved: number; reservedPending: number }>();
  if (!variantIds.length) return out;
  const transit = await transitLocationId();
  const [rows, res] = await Promise.all([
    db.$queryRaw<{ variantId: number; locationId: number; kind: string; qty: number }[]>`
      SELECT b."variantId", b."locationId", l."kind"::text AS kind, b."qty" FROM "StockBalance" b JOIN "StockLocation" l ON l.id = b."locationId"
      WHERE b."variantId" IN (${Prisma.join(variantIds)}) AND b."qty" <> 0`,
    // Нөөц: нийт ба «Төлбөр хүлээж буй» захиалгынх (#43 8 — агуулахад тусдаа харагдана)
    db.$queryRaw<{ variantId: number; total: number; pending: number }[]>`
      SELECT r."variantId", sum(r.qty)::int AS total, COALESCE(sum(r.qty) FILTER (WHERE o.status = 'PENDING_PAYMENT'), 0)::int AS pending
      FROM "StockReservation" r LEFT JOIN "Order" o ON o.id = r."orderId" WHERE r."variantId" IN (${Prisma.join(variantIds)}) GROUP BY r."variantId"`,
  ]);
  for (const id of variantIds) out.set(id, { byLocation: new Map(), transit: 0, staff: 0, driver: 0, warehouses: 0, reserved: 0, reservedPending: 0 });
  for (const r of rows) {
    const o = out.get(r.variantId)!;
    o.byLocation.set(r.locationId, r.qty);
    if (r.kind === 'WAREHOUSE') o.warehouses += r.qty;
    else if (r.locationId === transit) o.transit += r.qty;
    else if (r.kind === 'STAFF') o.staff += r.qty;
    else if (r.kind === 'DRIVER') o.driver += r.qty;
  }
  for (const r of res) { const o = out.get(r.variantId)!; o.reserved = r.total; o.reservedPending = r.pending; }
  return out;
}

/** Агуулахын үлдэгдлийн жагсаалт — хувилбар бүр нэг мөр, агуулах тус бүрийн багана */
export async function stockList(actor: UserActor, params: { q?: string; categoryId?: number; warehouseId?: number; inStock?: boolean; sort?: string; page?: number; ids?: number[] }) {
  requireRole(canView(actor.roles, 'warehouse'));
  const whs = await warehousesWithLoc();
  // Гараар бичсэн SQL: барааны кодын индексээр алхаж эхний 51 мөрийг авна (Prisma-ийн хувилбар 60,000 мөрийг эрэмбэлдэг байсан)
  const conds: Prisma.Sql[] = [];
  if (params.ids?.length) conds.push(Prisma.sql`v.id IN (${Prisma.join(params.ids.slice(0, STOCK_PAGE_SIZE))})`);
  else conds.push(Prisma.sql`p.status <> 'ARCHIVED'`);
  const q = params.q?.trim();
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conds.push(Prisma.sql`(p.name ILIKE ${like} OR p.code ILIKE ${like} OR v.code ILIKE ${like} OR v.color ILIKE ${like})`);
  }
  if (params.categoryId) conds.push(Prisma.sql`p."categoryId" = ${params.categoryId}`);
  const locIds = params.warehouseId ? whs.filter((w) => w.id === params.warehouseId).map((w) => w.locationId) : whs.map((w) => w.locationId);
  if (params.inStock || params.warehouseId) {
    conds.push(Prisma.sql`EXISTS (SELECT 1 FROM "StockBalance" b WHERE b."variantId" = v.id AND b."locationId" IN (${Prisma.join(locIds.length ? locIds : [-1])}) AND b.qty > 0)`);
  }
  const page = Math.max(1, Math.min(10000, Math.floor(params.page ?? 1)));
  const order = params.sort === 'shelf' ? Prisma.sql`p."shelfCode" ASC NULLS LAST, p.code, v."sortOrder", v.id` : Prisma.sql`p.code, v."sortOrder", v.id`;
  const fetched = await db.$queryRaw<{ id: number; isActive: boolean; status: string }[]>`
    SELECT v.id, v."isActive", p.status::text AS status FROM "ProductVariant" v JOIN "Product" p ON p.id = v."productId"
    WHERE ${Prisma.join(conds, ' AND ')} ORDER BY ${order}
    LIMIT ${STOCK_PAGE_SIZE + 1} OFFSET ${(page - 1) * STOCK_PAGE_SIZE}`;
  const hasMore = fetched.length > STOCK_PAGE_SIZE;
  const rows = fetched.slice(0, STOCK_PAGE_SIZE);
  const ids = rows.map((r) => r.id);
  const [info, bal] = await Promise.all([variantInfo(ids), balancesFor(ids)]);
  return {
    page, pageSize: STOCK_PAGE_SIZE, hasMore, warehouses: whs.map(({ id, name, isPrimary }) => ({ id, name, isPrimary })),
    canOperate: canOperateStock(actor.roles),
    items: rows.map((r) => {
      const b = bal.get(r.id)!;
      return {
        variantId: r.id, ...info.get(r.id)!, isActive: r.isActive, productStatus: r.status,
        byWarehouse: Object.fromEntries(whs.map((w) => [w.id, b.byLocation.get(w.locationId) ?? 0])),
        transit: b.transit, staff: b.staff, driver: b.driver, total: b.warehouses, reserved: b.reserved, reservedPending: b.reservedPending, available: b.warehouses - b.reserved,
      };
    }),
  };
}

/** Барааны жагсаалтад (Модуль 1) харуулах үлдэгдэл: бараа бүрийн агуулах дахь нийт ба захиалах боломжтой */
export async function productStockTotals(productIds: number[]) {
  const m = new Map<number, { total: number; available: number; byVariant: Map<number, { total: number; available: number }> }>();
  if (!productIds.length) return m;
  const rows = await db.$queryRaw<{ productId: number; variantId: number; total: number; reserved: number }[]>`
    SELECT v."productId", v.id AS "variantId",
      COALESCE((SELECT sum(b.qty) FROM "StockBalance" b JOIN "StockLocation" l ON l.id = b."locationId" AND l.kind = 'WAREHOUSE' WHERE b."variantId" = v.id), 0)::int AS total,
      COALESCE((SELECT sum(r.qty) FROM "StockReservation" r WHERE r."variantId" = v.id), 0)::int AS reserved
    FROM "ProductVariant" v WHERE v."productId" IN (${Prisma.join(productIds)})`;
  for (const r of rows) {
    const p = m.get(r.productId) ?? { total: 0, available: 0, byVariant: new Map() };
    p.total += r.total; p.available += r.total - r.reserved;
    p.byVariant.set(r.variantId, { total: r.total, available: r.total - r.reserved });
    m.set(r.productId, p);
  }
  return m;
}

// ───────────────────────── түүх ─────────────────────────

export interface MoveFilter { productId?: number; variantId?: number; warehouseId?: number; type?: string; from?: string; to?: string; docType?: string; docId?: number; page?: number }

function ubDay(ymd: string, add = 0): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) throw badRequest('Огноо буруу');
  const d = new Date(`${ymd}T00:00:00+08:00`);
  d.setUTCDate(d.getUTCDate() + add);
  return d;
}

async function moveWhere(f: MoveFilter): Promise<{ where: Prisma.StockMoveWhereInput; locationId: number | null }> {
  const and: Prisma.StockMoveWhereInput[] = [];
  let locationId: number | null = null;
  if (f.variantId) and.push({ variantId: f.variantId });
  else if (f.productId) and.push({ variant: { productId: f.productId } });
  if (f.warehouseId) {
    const w = await db.warehouse.findUnique({ where: { id: f.warehouseId }, include: { location: true } });
    if (!w?.location) throw notFound('Агуулах олдсонгүй');
    locationId = w.location.id;
  }
  if (f.type && f.type !== 'all') {
    const groups: Record<string, MoveType[]> = {
      receipt: ['RECEIPT'], transfer: ['TRANSFER_SEND', 'TRANSFER_RECEIVE', 'TRANSFER_BACK', 'TRANSFER_LOSS'], issue: ['ISSUE'],
      count: ['COUNT_PLUS', 'COUNT_MINUS'], loan: ['LOAN_OUT', 'LOAN_RETURN', 'LOAN_CHARGE'],
    };
    const types = groups[f.type] ?? (Object.keys(MOVE_LABEL).includes(f.type) ? [f.type as MoveType] : null);
    if (!types) throw badRequest('Төрөл буруу');
    and.push({ type: { in: types } });
  }
  if (f.from) and.push({ at: { gte: ubDay(f.from) } });
  if (f.to) and.push({ at: { lt: ubDay(f.to, 1) } });
  if (f.docType) and.push({ docType: f.docType });
  if (f.docId) and.push({ docId: f.docId });
  return { where: and.length ? { AND: and } : {}, locationId };
}

/** Хөдөлгөөний түүх — бүх хөдөлгөөн, шүүлттэй, хуудаслана (1 сая+ мөрт индексээр) */
export async function moveHistory(actor: UserActor, f: MoveFilter) {
  requireRole(canView(actor.roles, 'warehouse'));
  const { where, locationId } = await moveWhere(f);
  const page = Math.max(1, Math.min(2000, Math.floor(f.page ?? 1)));
  // Нийт тоог хэт их мөрөнд тоолохгүй — дараагийн хуудас байгаа эсэхийг нэг мөр илүү авч мэднэ
  let rows;
  if (locationId) {
    // «fromId = X OR toId = X» нь 1 сая мөрийг ухраан шүүдэг — хоёр индекстэй хайлт болгож нийлүүлнэ
    const k = page * MOVE_PAGE_SIZE + 1;
    const [a, b] = await Promise.all([
      db.stockMove.findMany({ where: { AND: [where, { fromId: locationId }] }, orderBy: { id: 'desc' }, take: k, select: { id: true } }),
      db.stockMove.findMany({ where: { AND: [where, { toId: locationId }] }, orderBy: { id: 'desc' }, take: k, select: { id: true } }),
    ]);
    const ids = [...new Set([...a, ...b].map((x) => x.id))].sort((x, y) => (x < y ? 1 : x > y ? -1 : 0)).slice((page - 1) * MOVE_PAGE_SIZE, page * MOVE_PAGE_SIZE + 1);
    rows = ids.length ? await db.stockMove.findMany({ where: { id: { in: ids } }, orderBy: { id: 'desc' } }) : [];
  } else {
    rows = await db.stockMove.findMany({ where, orderBy: { id: 'desc' }, skip: (page - 1) * MOVE_PAGE_SIZE, take: MOVE_PAGE_SIZE + 1 });
  }
  const hasMore = rows.length > MOVE_PAGE_SIZE;
  const list = rows.slice(0, MOVE_PAGE_SIZE);
  const [info, locs] = await Promise.all([
    variantInfo([...new Set(list.map((m) => m.variantId))]),
    db.stockLocation.findMany({ where: { id: { in: [...new Set(list.flatMap((m) => [m.fromId, m.toId]).filter((x): x is number => x !== null))] } }, select: { id: true, name: true, kind: true } }),
  ]);
  const ln = new Map(locs.map((l) => [l.id, l.name]));
  return {
    page, pageSize: MOVE_PAGE_SIZE, hasMore,
    items: list.map((m) => ({
      id: m.id.toString(), at: m.at, type: m.type, typeLabel: MOVE_LABEL[m.type], qty: m.qty,
      from: m.fromId ? ln.get(m.fromId) ?? '?' : null, to: m.toId ? ln.get(m.toId) ?? '?' : null,
      variantId: m.variantId, ...info.get(m.variantId), docType: m.docType, docId: m.docId, note: m.note, actorName: m.actorName,
    })),
  };
}

/** «Барааны түүх» (#39): бүх хувилбарын бүх хөдөлгөөн + нийлбэр + одоо хаана хэд */
export async function productStockHistory(actor: UserActor, productIdInput: unknown, f: MoveFilter) {
  requireRole(canView(actor.roles, 'warehouse'));
  const productId = cleanId(productIdInput, 'Бараа');
  const p = await db.product.findUnique({ where: { id: productId }, select: { id: true, code: true, name: true, shelfCode: true, variants: { orderBy: { sortOrder: 'asc' }, select: { id: true } } } });
  if (!p) throw notFound('Бараа олдсонгүй');
  const vids = p.variants.map((v) => v.id);
  if (f.variantId && !vids.includes(f.variantId)) throw badRequest('Хувилбар энэ барааных биш');
  const scope = f.variantId ? [f.variantId] : vids;
  const [history, summary, where, info] = await Promise.all([
    moveHistory(actor, { ...f, productId: f.variantId ? undefined : productId }),
    db.stockMove.groupBy({ by: ['type'], where: { variantId: { in: scope } }, _sum: { qty: true }, _count: true }),
    db.$queryRaw<{ locationId: number; name: string; kind: string; qty: number }[]>`
      SELECT b."locationId", l.name, l.kind::text AS kind, sum(b.qty)::int AS qty FROM "StockBalance" b JOIN "StockLocation" l ON l.id = b."locationId"
      WHERE b."variantId" IN (${Prisma.join(scope)}) AND b.qty > 0 GROUP BY b."locationId", l.name, l.kind ORDER BY l.kind, l.name`,
    variantInfo(vids),
  ]);
  return {
    product: { id: p.id, code: p.code, name: p.name, shelfCode: p.shelfCode },
    variants: vids.map((id) => ({ id, ...info.get(id)! })),
    summary: summary.map((s) => ({ type: s.type, label: MOVE_LABEL[s.type], qty: s._sum.qty ?? 0, count: s._count })),
    whereNow: where,
    history,
  };
}

// ───────────────────────── дүүргэлт (#39) ─────────────────────────

/**
 * Үндсэн агуулахын дүүргэлт: хүргэлтэд гараагүй захиалгын хэрэгцээ (нөөцлөлт) > үндсэн агуулахын тавиур → анхааруулга.
 * Замдаа ирж буй шилжүүлгийг тооцож, хаанаас авахыг (их үлдэгдэлтэйгээс нь) санал болгоно.
 */
export async function refillList(actor: UserActor) {
  requireRole(canView(actor.roles, 'warehouse'));
  const whs = await warehousesWithLoc();
  const primary = whs.find((w) => w.isPrimary);
  if (!primary) return { primary: null, items: [], plan: [] };
  const rows = await db.$queryRaw<{ variantId: number; demand: number; onShelf: number; incoming: number }[]>`
    WITH d AS (SELECT "variantId", sum(qty)::int AS demand FROM "StockReservation" GROUP BY "variantId")
    SELECT d."variantId", d.demand,
      COALESCE((SELECT b.qty FROM "StockBalance" b WHERE b."locationId" = ${primary.locationId} AND b."variantId" = d."variantId"), 0)::int AS "onShelf",
      COALESCE((SELECT sum(tl."sentQty") FROM "StockTransferLine" tl JOIN "StockTransfer" t ON t.id = tl."transferId"
                WHERE t.status = 'SENT' AND t."toWarehouseId" = ${primary.id} AND tl."variantId" = d."variantId"), 0)::int AS incoming
    FROM d WHERE d.demand > COALESCE((SELECT b.qty FROM "StockBalance" b WHERE b."locationId" = ${primary.locationId} AND b."variantId" = d."variantId"), 0)
    ORDER BY d.demand DESC LIMIT 500`;
  const ids = rows.map((r) => r.variantId);
  const others = whs.filter((w) => !w.isPrimary);
  const [info, bal] = await Promise.all([variantInfo(ids), ids.length && others.length ? db.stockBalance.findMany({ where: { variantId: { in: ids }, locationId: { in: others.map((w) => w.locationId) }, qty: { gt: 0 } } }) : []]);
  const byLoc = new Map(others.map((w) => [w.locationId, w]));
  const items = rows.map((r) => {
    const shortage = r.demand - r.onShelf;
    const toSend = Math.max(0, shortage - r.incoming);
    const sources = bal.filter((b) => b.variantId === r.variantId).map((b) => ({ warehouseId: byLoc.get(b.locationId)!.id, name: byLoc.get(b.locationId)!.name, qty: b.qty })).sort((a, b) => b.qty - a.qty);
    // Их үлдэгдэлтэйгээс нь эхэлж хуваарилна
    let left = toSend;
    const suggest = sources.map((s) => { const take = Math.min(left, s.qty); left -= take; return { ...s, take }; }).filter((s) => s.take > 0);
    return { variantId: r.variantId, ...info.get(r.variantId)!, demand: r.demand, onShelf: r.onShelf, incoming: r.incoming, shortage, toSend, sources, suggest, uncovered: left };
  });
  // Нэг товчоор: агуулах бүрээс нэг шилжүүлэг
  const plan = new Map<number, { warehouseId: number; name: string; lines: { variantId: number; qty: number }[] }>();
  for (const it of items) for (const s of it.suggest) {
    const p = plan.get(s.warehouseId) ?? { warehouseId: s.warehouseId, name: s.name, lines: [] };
    p.lines.push({ variantId: it.variantId, qty: s.take });
    plan.set(s.warehouseId, p);
  }
  return { primary: { id: primary.id, name: primary.name }, items, plan: [...plan.values()] };
}

// ───────────────────────── өнөөдрийн ажил (#39) ─────────────────────────

export interface TodayCounts { refill: number; incoming: number; discrepancy: number; loanRequests: number; countsToApprove: number; openCounts: number; returns: number }

/** Агуулахын «Өнөөдрийн ажил» самбар ба цэсний тэмдэгт (15 сек санана; ажлын хуудас өөрөө шинэ тоог авна) */
export async function todayWork(actor: UserActor, opts: { fresh?: boolean } = {}): Promise<TodayCounts & { approver: boolean }> {
  requireRole(canView(actor.roles, 'warehouse'));
  const approver = canApproveStock(actor.roles);
  const cached = stockCache.today as { at: number; data: TodayCounts } | null;
  if (!opts.fresh && cached && Date.now() - cached.at < 15_000) return { ...cached.data, approver };
  const primary = await db.warehouse.findFirst({ where: { isPrimary: true, isActive: true }, include: { location: true } });
  const [refill, incoming, discrepancy, loanRequests, countsToApprove, openCounts] = await Promise.all([
    primary?.location ? db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM (SELECT "variantId", sum(qty) AS demand FROM "StockReservation" GROUP BY "variantId") d
      WHERE d.demand > COALESCE((SELECT b.qty FROM "StockBalance" b WHERE b."locationId" = ${primary.location.id} AND b."variantId" = d."variantId"), 0)`.then((r) => r[0]?.n ?? 0) : 0,
    db.stockTransfer.count({ where: { status: 'SENT' } }),
    db.stockTransfer.count({ where: { status: 'DISCREPANCY' } }),
    db.staffLoan.count({ where: { status: 'REQUESTED' } }),
    db.stockCount.count({ where: { status: 'SUBMITTED' } }),
    db.stockCount.count({ where: { status: 'OPEN' } }),
  ]);
  const data = { refill, incoming, discrepancy, loanRequests, countsToApprove, openCounts, returns: 0 };
  stockCache.today = { at: Date.now(), data };
  return { ...data, approver };
}

/** Цэсний тэмдэгт: тухайн хүний хийх ажлын тоо */
export async function warehouseBadge(actor: UserActor): Promise<number> {
  if (!canView(actor.roles, 'warehouse')) return 0;
  const t = await todayWork(actor);
  if (!canOperateStock(actor.roles)) return 0;
  return t.refill + t.incoming + t.loanRequests + (t.approver ? t.countsToApprove + t.discrepancy : 0);
}
export function bustTodayCache() { stockCache.today = null; }

// ───────────────────────── тулгалт ─────────────────────────

let reconcileCache: { at: number; data: Awaited<ReturnType<typeof runReconcile>> } | null = null;
async function runReconcile() {
  const t0 = Date.now();
  const rows = await db.$queryRaw<{ locationId: number; variantId: number; ledger: number; balance: number }[]>`
    WITH j AS (
      SELECT loc AS "locationId", "variantId", sum(q)::int AS ledger FROM (
        SELECT "toId" AS loc, "variantId", qty AS q FROM "StockMove" WHERE "toId" IS NOT NULL
        UNION ALL SELECT "fromId", "variantId", -qty FROM "StockMove" WHERE "fromId" IS NOT NULL) x
      GROUP BY loc, "variantId")
    SELECT COALESCE(j."locationId", b."locationId") AS "locationId", COALESCE(j."variantId", b."variantId") AS "variantId",
      COALESCE(j.ledger, 0) AS ledger, COALESCE(b.qty, 0) AS balance
    FROM j FULL OUTER JOIN "StockBalance" b ON b."locationId" = j."locationId" AND b."variantId" = j."variantId"
    WHERE COALESCE(j.ledger, 0) <> COALESCE(b.qty, 0) LIMIT 100`;
  const totals = await db.$queryRaw<{ moves: bigint }[]>`SELECT count(*) AS moves FROM "StockMove"`;
  return { ok: rows.length === 0, mismatches: rows, moves: Number(totals[0]?.moves ?? 0), checkedAt: new Date(), ms: Date.now() - t0 };
}

/** «Журналын нийлбэр = үлдэгдэл» шалгалт. 5 минут санана; «Дахин шалгах» нь шууд ажиллуулна (зөвхөн админ). */
export async function reconcile(actor: UserActor, opts: { fresh?: boolean } = {}) {
  requireRole(canView(actor.roles, 'warehouse'));
  if (opts.fresh) requireRole(canApproveStock(actor.roles));
  if (!opts.fresh && reconcileCache && Date.now() - reconcileCache.at < 5 * 60_000) return reconcileCache.data;
  const data = await runReconcile();
  reconcileCache = { at: Date.now(), data };
  return data;
}

// ───────────────────────── тавиур (#38) ─────────────────────────

export function cleanShelf(v: unknown): string | null {
  const s = String(v ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (!s) return null;
  if (!/^[0-9A-ZА-ЯЁӨҮ][0-9A-ZА-ЯЁӨҮ.-]{0,11}$/.test(s)) throw badRequest('Тавиурын код 1–12 тэмдэгт (үсэг, тоо, «-»). Жишээ: A-3', 'bad_shelf');
  return s;
}

/** Олон барааг нэг дор тавиурт оноох (хоосон = тавиураас хасах) */
export async function setShelf(actor: UserActor, input: { productIds?: unknown; shelfCode?: unknown }) {
  requireRole(canOperateStock(actor.roles), 'Тавиурыг Агуулах, Админ ононо');
  if (!Array.isArray(input.productIds) || !input.productIds.length || input.productIds.length > 500) throw badRequest('Бараа сонгоно уу (500 хүртэл)');
  const ids = [...new Set((input.productIds as unknown[]).map((x) => cleanId(x, 'Бараа')))];
  const shelfCode = cleanShelf(input.shelfCode);
  const r = await db.$transaction(async (tx) => {
    const before = await tx.product.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, shelfCode: true } });
    if (before.length !== ids.length) throw badRequest('Бараа олдсонгүй');
    const n = await tx.product.updateMany({ where: { id: { in: ids } }, data: { shelfCode } });
    await writeAudit(actor, 'stock.shelf', 'Product', ids.length === 1 ? String(ids[0]) : null,
      { shelfCode, products: before.map((b) => ({ id: b.id, code: b.code, from: b.shelfCode })) }, tx, ['stock']);
    return n.count;
  });
  return { updated: r, shelfCode };
}
