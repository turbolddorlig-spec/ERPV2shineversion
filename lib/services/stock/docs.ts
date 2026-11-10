import type { IssueReason } from '@prisma/client';
import { db } from '../../db';
import { badRequest } from '../../errors';
import { writeAudit } from '../../audit';
import { canOperateStock } from '../../permissions';
import {
  ISSUE_REASON_LABEL, applyMoves, cleanId, cleanIdemKey, cleanLines, cleanNote, inTx, requireRole, uniqueViolation, warehouseLocation, type UserActor,
} from './core';

/** Орлого (#38): бараа, тоо, агуулах + тэмдэглэл. Олон бараа нэг баримтад. Шууд нэмэгдэнэ. */
export async function createReceipt(actor: UserActor, input: { warehouseId?: unknown; lines?: unknown; note?: unknown; idemKey?: unknown }) {
  requireRole(canOperateStock(actor.roles), 'Орлогыг Агуулах, Админ бүртгэнэ');
  const idemKey = cleanIdemKey(input.idemKey);
  const existing = await db.stockReceipt.findUnique({ where: { idemKey } });
  if (existing) return { receipt: existing, duplicate: true };
  const warehouseId = cleanId(input.warehouseId, 'Агуулах');
  const note = cleanNote(input.note);
  const { lines, labels } = await cleanLines(input.lines);
  try {
    const receipt = await inTx(async (tx) => {
      const { warehouse, locationId } = await warehouseLocation(tx, warehouseId);
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
      const r = await tx.stockIssue.create({ data: { warehouseId, reason, note, idemKey, createdById: actor.id, createdByName: actor.name } });
      await applyMoves(tx, actor, { type: 'issue', id: r.id }, lines.map((l) => ({ type: 'ISSUE', variantId: l.variantId, qty: l.qty, fromId: locationId, toId: null, note: `${ISSUE_REASON_LABEL[reason]}: ${note}` })), labels);
      await writeAudit(actor, 'stock.issue', 'StockIssue', String(r.id), { warehouse: warehouse.name, reason: ISSUE_REASON_LABEL[reason], lines: lines.length, total: lines.reduce((s, l) => s + l.qty, 0), note }, tx, ['stock']);
      return r;
    });
    return { issue, duplicate: false };
  } catch (e) {
    if (uniqueViolation(e)) { const r = await db.stockIssue.findUnique({ where: { idemKey } }); if (r) return { issue: r, duplicate: true }; }
    throw e;
  }
}
