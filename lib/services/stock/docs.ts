import type { IssueReason } from '@prisma/client';
import { db } from '../../db';
import { badRequest } from '../../errors';
import { writeAudit } from '../../audit';
import { canApproveStock, canOperateStock } from '../../permissions';
import { variantInfo } from './info';
import { bustTodayCache } from './views';
import {
  ISSUE_REASON_LABEL, applyMoves, assertNotReserved, lockActiveVariants, lockReservedVariants, cleanId, cleanIdemKey, cleanLines, cleanNote, inTx, requireRole, uniqueViolation, warehouseLocation, type UserActor,
} from './core';

/** Орлого (#38): бараа, тоо, агуулах + тэмдэглэл. Олон бараа нэг баримтад. Шууд нэмэгдэнэ. */
export async function createReceipt(actor: UserActor, input: { warehouseId?: unknown; lines?: unknown; note?: unknown; idemKey?: unknown }) {
  requireRole(canOperateStock(actor.roles), 'Орлогыг Агуулах, Админ бүртгэнэ');
  const idemKey = cleanIdemKey(input.idemKey);
  const existing = await db.stockReceipt.findUnique({ where: { idemKey } });
  if (existing) return { receipt: existing, duplicate: true };
  const warehouseId = cleanId(input.warehouseId, 'Агуулах');
  const note = cleanNote(input.note);
  const { lines, labels } = await cleanLines(input.lines, { activeOnly: true });
  try {
    const receipt = await inTx(async (tx) => {
      const { warehouse, locationId } = await warehouseLocation(tx, warehouseId);
      await lockActiveVariants(tx, lines.map((l) => l.variantId), labels);
      const r = await tx.stockReceipt.create({ data: { warehouseId, note, idemKey, createdById: actor.id, createdByName: actor.name } });
      await applyMoves(tx, actor, { type: 'receipt', id: r.id }, lines.map((l) => ({ type: 'RECEIPT', variantId: l.variantId, qty: l.qty, fromId: null, toId: locationId, note })), labels);
      await writeAudit(actor, 'stock.receipt', 'StockReceipt', String(r.id), { warehouse: warehouse.name, lines: lines.length, total: lines.reduce((s, l) => s + l.qty, 0), note }, tx, ['stock']);
      return r;
    });
    return { receipt, duplicate: false };
  } catch (e) {
    if (uniqueViolation(e)) { const r = await db.stockReceipt.findUnique({ where: { idemKey } }); if (r) return { receipt: r, duplicate: true }; }
    throw e;
  }
}

const REASONS: IssueReason[] = ['DAMAGE', 'SAMPLE', 'SUPPLIER_RETURN'];

/** Зарлага (#38): Гэмтэл · Дээж, бэлэг, реклам · Нийлүүлэгчид буцаасан. Тайлбар заавал. Шууд хасагдана, админ тайлангаас харна. */
export async function createIssue(actor: UserActor, input: { warehouseId?: unknown; reason?: unknown; lines?: unknown; note?: unknown; idemKey?: unknown }) {
  requireRole(canOperateStock(actor.roles), 'Зарлагыг Агуулах, Админ бүртгэнэ');
  const idemKey = cleanIdemKey(input.idemKey);
  const existing = await db.stockIssue.findUnique({ where: { idemKey } });
  if (existing) return { issue: existing, duplicate: true };
  const warehouseId = cleanId(input.warehouseId, 'Агуулах');
  const reason = String(input.reason ?? '') as IssueReason;
  if (!REASONS.includes(reason)) throw badRequest('Зарлагын шалтгаанаа сонгоно уу', 'reason_type');
  const note = cleanNote(input.note, { required: true })!;
  const { lines, labels } = await cleanLines(input.lines);
  try {
    const issue = await inTx(async (tx) => {
      const { warehouse, locationId } = await warehouseLocation(tx, warehouseId);
      await lockReservedVariants(tx, lines);
      const r = await tx.stockIssue.create({ data: { warehouseId, reason, note, idemKey, createdById: actor.id, createdByName: actor.name } });
      await applyMoves(tx, actor, { type: 'issue', id: r.id }, lines.map((l) => ({ type: 'ISSUE', variantId: l.variantId, qty: l.qty, fromId: locationId, toId: null, note: `${ISSUE_REASON_LABEL[reason]}: ${note}` })), labels);
      await assertNotReserved(tx, lines, labels, true);
      await writeAudit(actor, 'stock.issue', 'StockIssue', String(r.id), { warehouse: warehouse.name, reason: ISSUE_REASON_LABEL[reason], lines: lines.length, total: lines.reduce((s, l) => s + l.qty, 0), note }, tx, ['stock']);
      return r;
    });
    return { issue, duplicate: false };
  } catch (e) {
    if (uniqueViolation(e)) { const r = await db.stockIssue.findUnique({ where: { idemKey } }); if (r) return { issue: r, duplicate: true }; }
    throw e;
  }
}

// ───────────────────────── Зарлага хянах (Аудит #143, эзний шийдвэр) ─────────────────────────
// Зарлага шууд гарна (ажил удаашрахгүй), харин Супер админ / Админд үнийн дүнтэй жагсаалт гарч «Шалгасан» гэж тэмдэглэнэ.

const ISSUE_PAGE = 50;

export async function listIssues(actor: UserActor, p: { status?: string; page?: number }) {
  requireRole(canApproveStock(actor.roles), 'Зарлагыг Супер админ, Админ хянана');
  const status = p.status === 'reviewed' ? 'reviewed' : p.status === 'all' ? 'all' : 'pending';
  const page = Math.max(1, Math.min(1000, Math.floor(p.page ?? 1)));
  const where = status === 'pending' ? { reviewedAt: null } : status === 'reviewed' ? { reviewedAt: { not: null } } : {};
  const [rows, pendingCount] = await Promise.all([
    db.stockIssue.findMany({ where, orderBy: { id: 'desc' }, skip: (page - 1) * ISSUE_PAGE, take: ISSUE_PAGE + 1 }),
    db.stockIssue.count({ where: { reviewedAt: null } }),
  ]);
  const list = rows.slice(0, ISSUE_PAGE);
  const ids = list.map((r) => r.id);
  const moves = ids.length ? await db.stockMove.findMany({ where: { docType: 'issue', docId: { in: ids } }, select: { docId: true, variantId: true, qty: true } }) : [];
  const vids = [...new Set(moves.map((m) => m.variantId))];
  const [info, prices, whs] = await Promise.all([
    variantInfo(vids),
    vids.length ? db.productVariant.findMany({ where: { id: { in: vids } }, select: { id: true, priceOverride: true, product: { select: { price: true } } } }) : [],
    db.warehouse.findMany({ select: { id: true, name: true } }),
  ]);
  const price = new Map(prices.map((v) => [v.id, v.priceOverride ?? v.product.price]));
  const wn = new Map(whs.map((w) => [w.id, w.name]));
  return {
    status, page, hasMore: rows.length > ISSUE_PAGE, pendingCount,
    items: list.map((r) => {
      const ls = moves.filter((m) => m.docId === r.id).map((m) => ({ variantId: m.variantId, qty: m.qty, ...info.get(m.variantId), unitPrice: price.get(m.variantId) ?? 0 }));
      return {
        id: r.id, warehouse: wn.get(r.warehouseId) ?? '?', reason: r.reason, reasonLabel: ISSUE_REASON_LABEL[r.reason], note: r.note,
        createdByName: r.createdByName, createdAt: r.createdAt, reviewedAt: r.reviewedAt, reviewedByName: r.reviewedByName,
        lines: ls, pieces: ls.reduce((a, l) => a + l.qty, 0), value: ls.reduce((a, l) => a + l.qty * l.unitPrice, 0),
      };
    }),
  };
}

export async function reviewIssues(actor: UserActor, input: { ids?: unknown }) {
  requireRole(canApproveStock(actor.roles), 'Зарлагыг Супер админ, Админ хянана');
  const ids = Array.isArray(input.ids) ? [...new Set((input.ids as unknown[]).map((x) => cleanId(x, 'Зарлага')))].slice(0, 500) : [];
  if (!ids.length) throw badRequest('Зарлага сонгоно уу');
  const n = await db.$transaction(async (tx) => {
    const r = await tx.stockIssue.updateMany({ where: { id: { in: ids }, reviewedAt: null }, data: { reviewedAt: new Date(), reviewedByName: actor.name } });
    if (r.count) await writeAudit(actor, 'stock.issue_reviewed', 'StockIssue', ids.length === 1 ? String(ids[0]) : null, { ids, count: r.count }, tx, ['stock']);
    return r.count;
  });
  bustTodayCache();
  return { reviewed: n };
}
