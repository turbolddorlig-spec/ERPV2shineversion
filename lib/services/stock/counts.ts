import { Prisma, type CountStatus } from '@prisma/client';
import { db } from '../../db';
import { badRequest, conflict, notFound } from '../../errors';
import { writeAudit } from '../../audit';
import { canApproveStock, canOperateStock, canView } from '../../permissions';
import { applyMoves, cleanId, cleanNote, inTx, MAX_QTY, requireRole, uniqueViolation, warehouseLocation, type UserActor } from './core';
import { bustTodayCache } from './views';
import { variantInfo } from './info';

/**
 * Тооллого (#38): агуулах тоолно → систем ↔ тоолсон зөрүү → Админ тус бүр эсвэл «Бүгдийг зөвшөөрөх».
 * Батлахад зөрүүг (тоолсон − тоолох үеийн систем) «тооллогын засвар» хөдөлгөөнөөр бичнэ — хуучин тоог дарж бичихгүй.
 */
export const COUNT_STATUS_LABEL: Record<CountStatus, string> = { OPEN: 'Тоолж байна', SUBMITTED: 'Батлах хүлээгдэж буй', CLOSED: 'Дууссан', CANCELLED: 'Цуцалсан' };

export async function startCount(actor: UserActor, input: { warehouseId?: unknown; note?: unknown }) {
  requireRole(canOperateStock(actor.roles), 'Тооллогыг Агуулах, Админ хийнэ');
  const warehouseId = cleanId(input.warehouseId, 'Агуулах');
  const note = cleanNote(input.note, { required: true });
  await warehouseLocation(db, warehouseId);
  const openErr = async () => {
    const open = await db.stockCount.findFirst({ where: { warehouseId, status: { in: ['OPEN', 'SUBMITTED'] } } });
    return conflict(`Энэ агуулахад дуусаагүй тооллого (№${open?.id ?? '?'}) явагдаж байна — түүнийг үргэлжлүүлнэ үү`, 'count_open');
  };
  if (await db.stockCount.findFirst({ where: { warehouseId, status: { in: ['OPEN', 'SUBMITTED'] } }, select: { id: true } })) throw await openErr();
  // Аудит №5: нэг агуулахад нэг л идэвхтэй тооллого — database-ийн хэсэгчилсэн unique индекс (StockCount_one_active_per_warehouse)
  // хоёр таблет зэрэг дарсан ч хоёр дахийг нь татгалзана (өмнө нь давхар үүсч залруулга 2 удаа хийгддэг байв)
  try {
    const c = await inTx(async (tx) => {
      const c = await tx.stockCount.create({ data: { warehouseId, note, createdById: actor.id, createdByName: actor.name } });
      await writeAudit(actor, 'stock.count_started', 'StockCount', String(c.id), { warehouseId, note }, tx, ['stock']);
      return c;
    });
    bustTodayCache();
    return c;
  } catch (e) {
    if (uniqueViolation(e)) throw await openErr();
    throw e;
  }
}

async function loadCount(id: number) {
  const c = await db.stockCount.findUnique({ where: { id } });
  if (!c) throw notFound('Тооллого олдсонгүй');
  return c;
}

/** Нэг барааны тоолсон тоог оруулах (дахин оруулбал шинэчилнэ). Тоолох үеийн системийн тоог хадгална. */
export async function setCountLine(actor: UserActor, countIdInput: unknown, input: { variantId?: unknown; countedQty?: unknown }) {
  requireRole(canOperateStock(actor.roles));
  const countId = cleanId(countIdInput, 'Тооллого');
  const variantId = cleanId(input.variantId, 'Бараа');
  if (input.countedQty === null || input.countedQty === '') {
    await inTx(async (tx) => {
      const c = await lockCount(tx, countId);
      if (c.status !== 'OPEN') throw conflict('Тооллого илгээгдсэн байна', 'count_locked');
      await tx.stockCountLine.deleteMany({ where: { countId, variantId, status: 'PENDING' } });
    });
    return null;
  }
  const countedQty = Number(input.countedQty);
  if (!Number.isInteger(countedQty) || countedQty < 0 || countedQty > MAX_QTY) throw badRequest('Тоолсон тоо 0 эсвэл түүнээс их бүхэл тоо', 'bad_qty');
  // Илгээх / цуцлахтай зэрэг явахгүй (#124-Б): тооллогын мөрийг түгжээд л бичнэ
  return inTx(async (tx) => {
    const c = await lockCount(tx, countId);
    if (c.status !== 'OPEN') throw conflict('Тооллого илгээгдсэн байна. Шинэ тооллого эхлүүлнэ үү.', 'count_locked');
    const v = await tx.productVariant.findUnique({ where: { id: variantId }, select: { id: true } });
    if (!v) throw badRequest('Бараа олдсонгүй', 'variant_not_found');
    const { locationId } = await warehouseLocation(tx, c.warehouseId, { allowInactive: true });
    const systemQty = (await tx.stockBalance.findUnique({ where: { locationId_variantId: { locationId, variantId } } }))?.qty ?? 0;
    const data = { systemQty, countedQty, countedAt: new Date(), countedById: actor.id, countedByName: actor.name };
    return tx.stockCountLine.upsert({ where: { countId_variantId: { countId, variantId } }, create: { countId, variantId, ...data }, update: data });
  });
}

/** Тооллогын мөрийг түгжинэ (#124-Б) — тоолох, илгээх, батлах, цуцлах нэг зэрэг явахгүй */
async function lockCount(tx: Prisma.TransactionClient, id: number) {
  await tx.$queryRaw`SELECT id FROM "StockCount" WHERE id = ${id} FOR UPDATE`;
  const c = await tx.stockCount.findUnique({ where: { id } });
  if (!c) throw notFound('Тооллого олдсонгүй');
  return c;
}

export async function submitCount(actor: UserActor, idInput: unknown) {
  requireRole(canOperateStock(actor.roles));
  const id = cleanId(idInput, 'Тооллого');
  const done = await inTx(async (tx) => {
    const c = await lockCount(tx, id);
    if (c.status === 'SUBMITTED') return false;
    if (c.status !== 'OPEN') throw conflict('Тооллого дууссан байна');
    const n = await tx.stockCountLine.count({ where: { countId: id } });
    if (!n) throw badRequest('Дор хаяж нэг бараа тоолно уу', 'no_lines');
    await tx.stockCount.update({ where: { id }, data: { status: 'SUBMITTED', submittedAt: new Date() } });
    await writeAudit(actor, 'stock.count_submitted', 'StockCount', String(id), { lines: n }, tx, ['stock']);
    return true;
  });
  if (done) bustTodayCache();
  return loadCount(id);
}

/** Батлах / татгалзах (Супер админ / Админ). lineIds = 'all' бол шийдээгүй бүгдийг. */
export async function decideCount(actor: UserActor, idInput: unknown, input: { lineIds?: unknown; action?: unknown }) {
  requireRole(canApproveStock(actor.roles), 'Тооллогыг Супер админ, Админ батална');
  const id = cleanId(idInput, 'Тооллого');
  const action = input.action;
  if (action !== 'approve' && action !== 'reject') throw badRequest('Үйлдэл буруу');
  const all = input.lineIds === 'all';
  const ids = all ? [] : Array.isArray(input.lineIds) ? (input.lineIds as unknown[]).map((x) => cleanId(x, 'Мөр')) : null;
  if (!all && (!ids || !ids.length)) throw badRequest('Мөр сонгоно уу');
  return inTx(async (tx) => {
    const c = await lockCount(tx, id);
    if (c.status !== 'SUBMITTED') throw conflict(c.status === 'OPEN' ? 'Тооллого хараахан илгээгдээгүй байна' : 'Тооллого дууссан байна', 'count_not_submitted');
    const lines = await tx.stockCountLine.findMany({ where: { countId: id, status: 'PENDING', ...(all ? {} : { id: { in: ids! } }) }, orderBy: { variantId: 'asc' } });
    const { warehouse, locationId } = await warehouseLocation(tx, c.warehouseId, { allowInactive: true });
    let plus = 0; let minus = 0;
    const moves = [];
    for (const l of lines) {
      // Давхар батлахаас хамгаална
      const delta = action === 'approve' ? l.countedQty - l.systemQty : null;
      const ok = await tx.stockCountLine.updateMany({ where: { id: l.id, status: 'PENDING' }, data: { status: action === 'approve' ? 'APPROVED' : 'REJECTED', appliedDelta: delta, decidedById: actor.id, decidedByName: actor.name, decidedAt: new Date() } });
      if (!ok.count || !delta) continue;
      if (delta > 0) { plus += delta; moves.push({ type: 'COUNT_PLUS' as const, variantId: l.variantId, qty: delta, fromId: null, toId: locationId, note: `Тооллого №${id}: систем ${l.systemQty} → тоолсон ${l.countedQty}` }); }
      else { minus += -delta; moves.push({ type: 'COUNT_MINUS' as const, variantId: l.variantId, qty: -delta, fromId: locationId, toId: null, note: `Тооллого №${id}: систем ${l.systemQty} → тоолсон ${l.countedQty}` }); }
    }
    await applyMoves(tx, actor, { type: 'count', id }, moves);
    const left = await tx.stockCountLine.count({ where: { countId: id, status: 'PENDING' } });
    if (!left) await tx.stockCount.update({ where: { id }, data: { status: 'CLOSED', closedAt: new Date() } });
    await writeAudit(actor, action === 'approve' ? 'stock.count_approved' : 'stock.count_rejected', 'StockCount', String(id), { warehouse: warehouse.name, lines: lines.length, plus, minus }, tx, ['stock']);
    return { decided: lines.length, plus, minus, closed: !left };
  });
}

export async function cancelCount(actor: UserActor, idInput: unknown) {
  requireRole(canOperateStock(actor.roles));
  const id = cleanId(idInput, 'Тооллого');
  await inTx(async (tx) => {
    const c = await lockCount(tx, id);
    if (c.status === 'CANCELLED') return;
    if (c.status === 'CLOSED') throw conflict('Дууссан тооллогыг цуцлахгүй');
    if (c.status === 'SUBMITTED' && !canApproveStock(actor.roles)) throw conflict('Илгээсэн тооллогыг Админ цуцална');
    await tx.stockCountLine.updateMany({ where: { countId: id, status: 'PENDING' }, data: { status: 'REJECTED', decidedById: actor.id, decidedByName: actor.name, decidedAt: new Date() } });
    await tx.stockCount.update({ where: { id }, data: { status: 'CANCELLED', closedAt: new Date() } });
    await writeAudit(actor, 'stock.count_cancelled', 'StockCount', String(id), {}, tx, ['stock']);
  });
  bustTodayCache();
  return loadCount(id);
}

export async function listCounts(actor: UserActor, params: { status?: string; page?: number }) {
  requireRole(canView(actor.roles, 'warehouse'));
  const where: Prisma.StockCountWhereInput = params.status === 'open' ? { status: { in: ['OPEN', 'SUBMITTED'] } } : params.status && params.status !== 'all' ? { status: params.status as CountStatus } : {};
  const page = Math.max(1, Math.floor(params.page ?? 1));
  const [total, rows, whs] = await Promise.all([
    db.stockCount.count({ where }),
    db.stockCount.findMany({ where, orderBy: { id: 'desc' }, skip: (page - 1) * 30, take: 30, include: { _count: { select: { lines: true } } } }),
    db.warehouse.findMany({ select: { id: true, name: true } }),
  ]);
  const wn = new Map(whs.map((w) => [w.id, w.name]));
  const diffs = rows.length ? await db.$queryRaw<{ countId: number; diffLines: number }[]>`
    SELECT "countId", count(*)::int AS "diffLines" FROM "StockCountLine" WHERE "countId" IN (${Prisma.join(rows.map((r) => r.id))}) AND "countedQty" <> "systemQty" GROUP BY "countId"` : [];
  const dm = new Map(diffs.map((d) => [d.countId, d.diffLines]));
  return {
    total, page, pageSize: 30,
    items: rows.map((c) => ({ id: c.id, warehouse: { id: c.warehouseId, name: wn.get(c.warehouseId) ?? '?' }, status: c.status, statusLabel: COUNT_STATUS_LABEL[c.status], note: c.note, lines: c._count.lines, diffLines: dm.get(c.id) ?? 0, createdBy: c.createdByName, createdAt: c.createdAt, submittedAt: c.submittedAt, closedAt: c.closedAt })),
  };
}

/** Тооллогын дэлгэрэнгүй: тоолсон мөрүүд + тоолсны дараа бараа хөдөлсөн эсэх */
export async function getCount(actor: UserActor, idInput: unknown) {
  requireRole(canView(actor.roles, 'warehouse'));
  const id = cleanId(idInput, 'Тооллого');
  const c = await db.stockCount.findUnique({ where: { id }, include: { lines: { orderBy: [{ status: 'asc' }, { id: 'asc' }] } } });
  if (!c) throw notFound('Тооллого олдсонгүй');
  const w = await db.warehouse.findUnique({ where: { id: c.warehouseId }, include: { location: true } });
  const locationId = w?.location?.id ?? 0;
  const vids = c.lines.map((l) => l.variantId);
  const [info, bals, moved] = await Promise.all([
    variantInfo(vids),
    vids.length ? db.stockBalance.findMany({ where: { locationId, variantId: { in: vids } } }) : [],
    // Тоолсны дараах хөдөлгөөн (энэ тооллогын засвараас бусад)
    vids.length ? db.$queryRaw<{ variantId: number }[]>`
      SELECT DISTINCT m."variantId" FROM "StockMove" m JOIN "StockCountLine" l ON l."variantId" = m."variantId" AND l."countId" = ${id}
      WHERE (m."fromId" = ${locationId} OR m."toId" = ${locationId}) AND m."at" > l."countedAt" AND NOT (m."docType" = 'count' AND m."docId" = ${id})` : [],
  ]);
  const bm = new Map(bals.map((b) => [b.variantId, b.qty]));
  const mv = new Set(moved.map((m) => m.variantId));
  return {
    id: c.id, status: c.status, statusLabel: COUNT_STATUS_LABEL[c.status], note: c.note, createdBy: c.createdByName, createdAt: c.createdAt, submittedAt: c.submittedAt, closedAt: c.closedAt,
    warehouse: { id: c.warehouseId, name: w?.name ?? '?' },
    lines: c.lines.map((l) => ({
      id: l.id, variantId: l.variantId, ...info.get(l.variantId), systemQty: l.systemQty, countedQty: l.countedQty, diff: l.countedQty - l.systemQty,
      currentQty: bm.get(l.variantId) ?? 0, movedSince: mv.has(l.variantId) && l.status === 'PENDING',
      status: l.status, countedBy: l.countedByName, countedAt: l.countedAt, decidedBy: l.decidedByName, decidedAt: l.decidedAt, appliedDelta: l.appliedDelta,
    })),
  };
}

