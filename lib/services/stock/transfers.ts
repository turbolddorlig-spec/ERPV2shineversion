import type { Prisma, TransferStatus } from '@prisma/client';
import { db } from '../../db';
import { AppError, badRequest, conflict, notFound } from '../../errors';
import { writeAudit } from '../../audit';
import { canApproveStock, canOperateStock, canView } from '../../permissions';
import {
  applyMoves, assertNotReserved, lockActiveVariants, lockReservedVariants, cleanId, cleanIdemKey, cleanLines, cleanNote, inTx, requireRole, transitLocationId, uniqueViolation, warehouseLocation, type UserActor,
} from './core';
import { variantInfo } from './info';

/**
 * Шилжүүлэг 2 алхамтай (#38): илгээсэн → «замдаа» → хүлээн авах агуулах тоолж батална.
 * Дутуу ирвэл DISCREPANCY; Супер админ / Админ «илгээгч рүү буцаах» эсвэл «хорогдол» гэж шийднэ.
 */
export const TRANSFER_STATUS_LABEL: Record<TransferStatus, string> = {
  SENT: 'Замдаа', RECEIVED: 'Хүлээн авсан', DISCREPANCY: 'Дутуу ирсэн', RESOLVED: 'Шийдсэн', CANCELLED: 'Цуцалсан',
};

export async function sendTransfer(actor: UserActor, input: { fromWarehouseId?: unknown; toWarehouseId?: unknown; lines?: unknown; note?: unknown; idemKey?: unknown; refill?: unknown }) {
  requireRole(canOperateStock(actor.roles), 'Шилжүүлгийг Агуулах, Админ хийнэ');
  const idemKey = cleanIdemKey(input.idemKey);
  const existing = await db.stockTransfer.findUnique({ where: { idemKey } });
  if (existing) return { transfer: existing, duplicate: true };
  const fromWarehouseId = cleanId(input.fromWarehouseId, 'Илгээх агуулах');
  const toWarehouseId = cleanId(input.toWarehouseId, 'Хүлээн авах агуулах');
  if (fromWarehouseId === toWarehouseId) throw badRequest('Илгээх, хүлээн авах агуулах өөр байх ёстой');
  const note = cleanNote(input.note);
  const { lines, labels } = await cleanLines(input.lines, { activeOnly: true });
  try {
    const transfer = await inTx(async (tx) => {
      const from = await warehouseLocation(tx, fromWarehouseId);
      const to = await warehouseLocation(tx, toWarehouseId);
      const transit = await transitLocationId(tx);
      // Б10: үндсэн агуулах руу (дүүргэлт) биш бол захиалгад түгжигдсэн барааг шилжүүлэхгүй
      await lockActiveVariants(tx, lines.map((l) => l.variantId), labels);
      if (!to.warehouse.isPrimary) await lockReservedVariants(tx, lines);
      const t = await tx.stockTransfer.create({
        data: {
          fromWarehouseId, toWarehouseId, note, idemKey, refill: input.refill === true, sentById: actor.id, sentByName: actor.name,
          lines: { create: lines.map((l) => ({ variantId: l.variantId, sentQty: l.qty })) },
        },
      });
      await applyMoves(tx, actor, { type: 'transfer', id: t.id },
        lines.map((l) => ({ type: 'TRANSFER_SEND' as const, variantId: l.variantId, qty: l.qty, fromId: from.locationId, toId: transit, note: `→ ${to.warehouse.name}` })), labels);
      if (!to.warehouse.isPrimary) await assertNotReserved(tx, lines, labels, true);
      await writeAudit(actor, 'stock.transfer_sent', 'StockTransfer', String(t.id), { from: from.warehouse.name, to: to.warehouse.name, lines: lines.length, total: lines.reduce((s, l) => s + l.qty, 0), refill: t.refill }, tx, ['stock']);
      return t;
    });
    return { transfer, duplicate: false };
  } catch (e) {
    if (uniqueViolation(e)) { const r = await db.stockTransfer.findUnique({ where: { idemKey } }); if (r) return { transfer: r, duplicate: true }; }
    throw e;
  }
}

async function loadTransfer(tx: Prisma.TransactionClient | typeof db, id: number) {
  const t = await tx.stockTransfer.findUnique({ where: { id }, include: { lines: { orderBy: { variantId: 'asc' } } } });
  if (!t) throw notFound('Шилжүүлэг олдсонгүй');
  return t;
}

/** Ирсэн тоогоо оруулж батална. Давтан дарахад (аль хэдийн хүлээн авсан) өөрчлөлтгүй буцаана. */
export async function receiveTransfer(actor: UserActor, idInput: unknown, input: { lines?: unknown; note?: unknown }) {
  requireRole(canOperateStock(actor.roles), 'Шилжүүлгийг Агуулах, Админ хүлээн авна');
  const id = cleanId(idInput, 'Шилжүүлэг');
  const note = cleanNote(input.note);
  const given = new Map<number, number>();
  if (!Array.isArray(input.lines)) throw badRequest('Ирсэн тоогоо оруулна уу');
  for (const raw of input.lines as { variantId?: unknown; receivedQty?: unknown }[]) {
    const v = cleanId(raw?.variantId, 'Бараа');
    const q = Number(raw?.receivedQty);
    if (!Number.isInteger(q) || q < 0) throw badRequest('Ирсэн тоо 0 эсвэл түүнээс их бүхэл тоо', 'bad_qty');
    given.set(v, q);
  }
  return inTx(async (tx) => {
    const t = await loadTransfer(tx, id);
    if (t.status !== 'SENT') {
      if (t.status === 'CANCELLED') throw conflict('Энэ шилжүүлэг цуцлагдсан байна', 'transfer_cancelled');
      return { transfer: t, duplicate: true };
    }
    // Аудит #143 (эзний шийдвэр): илгээсэн хүн өөрөө хүлээн авахгүй — «10 илгээж 0 ирсэн» гэж нэг хүн дутагдал үүсгэхгүй
    if (t.sentById === actor.id) throw new AppError(403, 'Шилжүүлгийг илгээсэн хүн өөрөө хүлээн авахгүй — хүлээн авах агуулахын өөр ажилтан тоолж авна', 'self_receive');
    for (const l of t.lines) {
      const q = given.get(l.variantId);
      if (q === undefined) throw badRequest('Бүх барааны ирсэн тоог оруулна уу', 'missing_lines');
      if (q > l.sentQty) throw badRequest(`Ирсэн тоо илгээснээс (${l.sentQty}) их байж болохгүй. Илүү ирсэн бол орлого эсвэл тооллогоор бүртгэнэ.`, 'bad_qty');
    }
    // Зэрэг 2 хүн хүлээн авбал нэг нь л амжилттай
    const ok = await tx.stockTransfer.updateMany({ where: { id, status: 'SENT' }, data: { status: 'RECEIVED' } });
    if (ok.count === 0) return { transfer: await loadTransfer(tx, id), duplicate: true };
    const to = await warehouseLocation(tx, t.toWarehouseId, { allowInactive: true });
    const transit = await transitLocationId(tx);
    let short = 0;
    for (const l of t.lines) {
      const q = given.get(l.variantId)!;
      short += l.sentQty - q;
      await tx.stockTransferLine.update({ where: { id: l.id }, data: { receivedQty: q } });
    }
    await applyMoves(tx, actor, { type: 'transfer', id }, t.lines.map((l) => ({ type: 'TRANSFER_RECEIVE' as const, variantId: l.variantId, qty: given.get(l.variantId)!, fromId: transit, toId: to.locationId, note })));
    const status: TransferStatus = short > 0 ? 'DISCREPANCY' : 'RECEIVED';
    const u = await tx.stockTransfer.update({ where: { id }, data: { status, receivedById: actor.id, receivedByName: actor.name, receivedAt: new Date() }, include: { lines: true } });
    await writeAudit(actor, 'stock.transfer_received', 'StockTransfer', String(id), { to: to.warehouse.name, short, note }, tx, short > 0 ? ['stock', 'discrepancy'] : ['stock']);
    return { transfer: u, duplicate: false };
  });
}

/** Хүлээн аваагүй шилжүүлгийг цуцлах — бараа илгээсэн агуулах руу буцна */
export async function cancelTransfer(actor: UserActor, idInput: unknown, input: { note?: unknown }) {
  requireRole(canOperateStock(actor.roles));
  const id = cleanId(idInput, 'Шилжүүлэг');
  const note = cleanNote(input.note, { required: true });
  return inTx(async (tx) => {
    const t = await loadTransfer(tx, id);
    if (t.status === 'CANCELLED') return { transfer: t, duplicate: true };
    if (t.status !== 'SENT') throw conflict('Хүлээн авсан шилжүүлгийг цуцлахгүй', 'transfer_received');
    const ok = await tx.stockTransfer.updateMany({ where: { id, status: 'SENT' }, data: { status: 'CANCELLED', resolvedById: actor.id, resolvedByName: actor.name, resolvedAt: new Date(), resolveNote: note } });
    if (ok.count === 0) return { transfer: await loadTransfer(tx, id), duplicate: true };
    const from = await warehouseLocation(tx, t.fromWarehouseId, { allowInactive: true });
    const transit = await transitLocationId(tx);
    await applyMoves(tx, actor, { type: 'transfer', id }, t.lines.map((l) => ({ type: 'TRANSFER_BACK' as const, variantId: l.variantId, qty: l.sentQty, fromId: transit, toId: from.locationId, note: `Цуцалсан: ${note}` })));
    await writeAudit(actor, 'stock.transfer_cancelled', 'StockTransfer', String(id), { note }, tx, ['stock']);
    return { transfer: await loadTransfer(tx, id), duplicate: false };
  });
}

/** Дутагдлыг шийдэх (Супер админ / Админ): мөр бүрээр «return» (илгээгч рүү) эсвэл «loss» (хорогдол) */
export async function resolveTransfer(actor: UserActor, idInput: unknown, input: { decisions?: unknown; note?: unknown }) {
  requireRole(canApproveStock(actor.roles), 'Дутагдлыг Супер админ, Админ шийднэ');
  const id = cleanId(idInput, 'Шилжүүлэг');
  const note = cleanNote(input.note, { required: true })!;
  const dec = new Map<number, 'return' | 'loss'>();
  if (Array.isArray(input.decisions)) {
    for (const d of input.decisions as { variantId?: unknown; action?: unknown }[]) {
      if (d?.action !== 'return' && d?.action !== 'loss') throw badRequest('Шийдвэр буруу');
      dec.set(cleanId(d.variantId, 'Бараа'), d.action);
    }
  } else if (input.decisions === 'return' || input.decisions === 'loss') {
    // бүгдэд нэг шийдвэр
  } else throw badRequest('Шийдвэрээ сонгоно уу');
  const all = typeof input.decisions === 'string' ? (input.decisions as 'return' | 'loss') : null;
  return inTx(async (tx) => {
    const t = await loadTransfer(tx, id);
    if (t.status === 'RESOLVED') return { transfer: t, duplicate: true };
    if (t.status !== 'DISCREPANCY') throw conflict('Энэ шилжүүлэгт шийдэх дутагдал алга');
    const ok = await tx.stockTransfer.updateMany({ where: { id, status: 'DISCREPANCY' }, data: { status: 'RESOLVED' } });
    if (ok.count === 0) return { transfer: await loadTransfer(tx, id), duplicate: true };
    const from = await warehouseLocation(tx, t.fromWarehouseId, { allowInactive: true });
    const transit = await transitLocationId(tx);
    const moves = [];
    for (const l of t.lines) {
      const short = l.sentQty - (l.receivedQty ?? 0) - l.returnedQty - l.lostQty;
      if (short <= 0) continue;
      const a = all ?? dec.get(l.variantId);
      if (!a) throw badRequest('Дутуу ирсэн бүх бараанд шийдвэр сонгоно уу', 'missing_lines');
      await tx.stockTransferLine.update({ where: { id: l.id }, data: a === 'return' ? { returnedQty: { increment: short } } : { lostQty: { increment: short } } });
      moves.push(a === 'return'
        ? { type: 'TRANSFER_BACK' as const, variantId: l.variantId, qty: short, fromId: transit, toId: from.locationId, note: `Дутагдал буцаасан: ${note}` }
        : { type: 'TRANSFER_LOSS' as const, variantId: l.variantId, qty: short, fromId: transit, toId: null, note: `Хорогдол: ${note}` });
    }
    await applyMoves(tx, actor, { type: 'transfer', id }, moves);
    const u = await tx.stockTransfer.update({ where: { id }, data: { resolvedById: actor.id, resolvedByName: actor.name, resolvedAt: new Date(), resolveNote: note }, include: { lines: true } });
    await writeAudit(actor, 'stock.transfer_resolved', 'StockTransfer', String(id), { note, returned: moves.filter((m) => m.type === 'TRANSFER_BACK').reduce((s, m) => s + m.qty, 0), lost: moves.filter((m) => m.type === 'TRANSFER_LOSS').reduce((s, m) => s + m.qty, 0) }, tx, ['stock']);
    return { transfer: u, duplicate: false };
  });
}

export const TRANSFER_PAGE_SIZE = 30;

export async function listTransfers(actor: UserActor, params: { status?: string; warehouseId?: number; incoming?: boolean; page?: number }) {
  requireRole(canView(actor.roles, 'warehouse'));
  const where: Prisma.StockTransferWhereInput = {};
  if (params.status === 'open') where.status = { in: ['SENT', 'DISCREPANCY'] };
  else if (params.status && params.status !== 'all') where.status = params.status as TransferStatus;
  if (params.warehouseId) where.OR = params.incoming ? [{ toWarehouseId: params.warehouseId }] : [{ fromWarehouseId: params.warehouseId }, { toWarehouseId: params.warehouseId }];
  const page = Math.max(1, Math.min(10000, Math.floor(params.page ?? 1)));
  const [total, rows, whs] = await Promise.all([
    db.stockTransfer.count({ where }),
    db.stockTransfer.findMany({ where, orderBy: { id: 'desc' }, skip: (page - 1) * TRANSFER_PAGE_SIZE, take: TRANSFER_PAGE_SIZE, include: { lines: true } }),
    db.warehouse.findMany({ select: { id: true, name: true } }),
  ]);
  const wn = new Map(whs.map((w) => [w.id, w.name]));
  return {
    total, page, pageSize: TRANSFER_PAGE_SIZE,
    items: rows.map((t) => ({
      id: t.id, status: t.status, statusLabel: TRANSFER_STATUS_LABEL[t.status], refill: t.refill,
      from: { id: t.fromWarehouseId, name: wn.get(t.fromWarehouseId) ?? '?' }, to: { id: t.toWarehouseId, name: wn.get(t.toWarehouseId) ?? '?' },
      lines: t.lines.length, totalQty: t.lines.reduce((s, l) => s + l.sentQty, 0),
      shortQty: t.lines.reduce((s, l) => s + (l.receivedQty === null ? 0 : l.sentQty - l.receivedQty), 0),
      sentBy: t.sentByName, sentAt: t.sentAt, receivedBy: t.receivedByName, receivedAt: t.receivedAt, note: t.note,
    })),
  };
}

export async function getTransfer(actor: UserActor, idInput: unknown) {
  requireRole(canView(actor.roles, 'warehouse'));
  const t = await loadTransfer(db, cleanId(idInput, 'Шилжүүлэг'));
  const [labels, whs] = await Promise.all([variantInfo(t.lines.map((l) => l.variantId)), db.warehouse.findMany({ select: { id: true, name: true } })]);
  const wn = new Map(whs.map((w) => [w.id, w.name]));
  return {
    ...t, statusLabel: TRANSFER_STATUS_LABEL[t.status],
    from: { id: t.fromWarehouseId, name: wn.get(t.fromWarehouseId) ?? '?' }, to: { id: t.toWarehouseId, name: wn.get(t.toWarehouseId) ?? '?' },
    lines: t.lines.map((l) => ({ ...l, ...labels.get(l.variantId) })),
  };
}

