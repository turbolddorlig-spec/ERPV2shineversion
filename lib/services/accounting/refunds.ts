import { Prisma } from '@prisma/client';
import { db } from '../../db';
import { badRequest, conflict, forbidden, notFound } from '../../errors';
import { writeAudit } from '../../audit';
import { canDecideRefund, canRequestRefund, canView } from '../../permissions';
import { inTx, type UserActor } from '../orders/core';
import { bustCounts } from '../orders/queries';
import { bankLock, paidCancelReviewIn, refundExcessIn, refundManualExcessIn, setRefundedIn } from './bank';

type Tx = Prisma.TransactionClient;

/**
 * #211 (эзэн): «💸 Буцаах хүсэлт» — Таараагүй, Илүү, Давхардсан, Төлсөн ч цуцлагдсан мөнгөнд
 * Оператор / Ахлах оператор банк, дансны дугаар, эзний нэр, шалтгаан бичиж хүсэлт илгээнэ.
 * Супер админ / Нягтлан шалгаад «Буцаасан» (одоо байгаа буцаалтын аргаар эцэслэнэ — болиулахгүй) эсвэл шалтгаантай «Татгалзсан».
 * Дүнг систем тооцно (гүйлгээний дүн / илүү дүн / төлсөн дүн); нэг гүйлгээ, захиалга дээр нэг л хүлээгдэж буй хүсэлт.
 */
export type RefundKind = 'TX' | 'EXCESS' | 'ORDER_EXCESS' | 'PAID_CANCELLED';
export const REFUND_KIND_LABEL: Record<RefundKind, string> = { TX: 'Таараагүй / давхардсан', EXCESS: 'Илүү төлөлт', ORDER_EXCESS: 'Илүү төлөлт (банкгүй)', PAID_CANCELLED: 'Төлсөн ч цуцлагдсан' };

const ACC = /^(MN\d{18}|\d{6,20})$/;
const txt = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Хүлээгдэж буй хүсэлтүүд (жагсаалтын мөр бүрт харуулах) — түлхүүр «t<гүйлгээ>» эсвэл «o<захиалга>» */
export async function pendingRefundFor(p: { txIds?: number[]; orderIds?: number[]; kind?: RefundKind }) {
  const or: Prisma.RefundRequestWhereInput[] = [];
  if (p.txIds?.length) or.push({ bankTransactionId: { in: p.txIds } });
  if (p.orderIds?.length) or.push({ orderId: { in: p.orderIds }, bankTransactionId: null, ...(p.kind ? { kind: p.kind } : {}) });
  const m = new Map<string, { id: number; requestedByName: string; requestedAt: Date; bankName: string; accountNo: string; accountName: string; amount: number }>();
  if (!or.length) return m;
  const rows = await db.refundRequest.findMany({ where: { status: 'PENDING', OR: or }, select: { id: true, bankTransactionId: true, orderId: true, requestedByName: true, requestedAt: true, bankName: true, accountNo: true, accountName: true, amount: true } });
  for (const r of rows) m.set(r.bankTransactionId ? `t${r.bankTransactionId}` : `o${r.orderId}`, r);
  return m;
}

/** Одоогийн буцаах дүн (хүсэлт үүсгэх, эцэслэхэд) — буцаах боломжгүй бол алдаа */
async function target(tx: Tx | typeof db, kind: RefundKind, id: number): Promise<{ amount: number; txId: number | null; orderId: number | null; orderNumber: string | null }> {
  if (kind === 'TX' || kind === 'EXCESS') {
    const t = await tx.bankTransaction.findUnique({ where: { id } });
    if (!t) throw notFound('Гүйлгээ олдсонгүй');
    if (t.refunded) throw conflict('Энэ гүйлгээ аль хэдийн буцаагдсан', 'already_refunded');
    if (kind === 'TX') {
      if (t.orderId) throw conflict('Захиалгатай таарсан гүйлгээ — зөвхөн таараагүй / давхардсан мөнгөнд', 'linked');
      return { amount: t.amount, txId: t.id, orderId: null, orderNumber: null };
    }
    if (!t.orderId || t.status !== 'EXCESS_AMOUNT' || t.isDuplicate) throw conflict('Зөвхөн «Илүү» төлөлттэй гүйлгээнд', 'not_excess');
    const o = await tx.order.findUniqueOrThrow({ where: { id: t.orderId }, select: { number: true, total: true } });
    const a = await tx.bankTransaction.aggregate({ where: { orderId: t.orderId, status: { in: ['MATCHED', 'EXCESS_AMOUNT', 'PARTIAL_PAYMENT'] }, isDuplicate: false, refunded: false }, _sum: { amount: true, excessRefunded: true } });
    const excess = (a._sum.amount ?? 0) - (a._sum.excessRefunded ?? 0) - o.total;
    if (excess <= 0) throw conflict('Илүү төлөлт алга', 'not_excess');
    return { amount: excess, txId: t.id, orderId: t.orderId, orderNumber: o.number };
  }
  const o = await tx.order.findUnique({ where: { id }, select: { id: true, number: true, total: true, paidAmount: true, prepaid: true, status: true, paidCancelReviewedAt: true } });
  if (!o) throw notFound('Захиалга олдсонгүй');
  if (kind === 'ORDER_EXCESS') {
    const excess = o.paidAmount - o.total;
    if (!o.prepaid || excess <= 0 || o.status === 'CANCELLED') throw conflict('Илүү төлөлт алга', 'not_excess');
    const bankEx = await tx.bankTransaction.count({ where: { orderId: id, status: 'EXCESS_AMOUNT', refunded: false, isDuplicate: false } });
    if (bankEx) throw conflict('Банкны гүйлгээтэй илүү — гүйлгээн дээрээс хүсэлт илгээнэ үү', 'bank_excess');
    return { amount: excess, txId: null, orderId: o.id, orderNumber: o.number };
  }
  if (o.status !== 'CANCELLED') throw conflict('Захиалга цуцлагдсан төлөвт байхгүй', 'bad_status');
  if (o.paidCancelReviewedAt) throw conflict('Энэ захиалгыг аль хэдийн шийдсэн', 'already_reviewed');
  const a = await tx.bankTransaction.aggregate({ where: { orderId: id, status: { in: ['MATCHED', 'EXCESS_AMOUNT', 'PARTIAL_PAYMENT'] }, isDuplicate: false, refunded: false }, _sum: { amount: true, excessRefunded: true } });
  const paid = (a._sum.amount ?? 0) - (a._sum.excessRefunded ?? 0);
  if (paid <= 0) throw conflict('Энэ захиалгад банкаар орсон мөнгө алга', 'no_money');
  return { amount: paid, txId: null, orderId: o.id, orderNumber: o.number };
}

export async function createRefundRequest(actor: UserActor, input: { kind?: unknown; id?: unknown; bankName?: unknown; accountNo?: unknown; accountName?: unknown; reason?: unknown }) {
  if (!canRequestRefund(actor.roles)) throw forbidden('Буцаах хүсэлт илгээх эрх байхгүй');
  const kind = String(input.kind ?? '') as RefundKind;
  if (!(kind in REFUND_KIND_LABEL)) throw badRequest('Төрөл буруу');
  const id = Number(input.id);
  if (!Number.isInteger(id) || id <= 0) throw notFound('Олдсонгүй');
  const bankName = txt(input.bankName, 60);
  const accountNo = String(input.accountNo ?? '').replace(/[\s-]/g, '').toUpperCase();
  const accountName = txt(input.accountName, 100);
  const reason = txt(input.reason, 500);
  if (bankName.length < 2) throw badRequest('Банкны нэрийг бичнэ үү', 'bank_required');
  if (!ACC.test(accountNo)) throw badRequest('Дансны дугаар буруу: зөвхөн цифр (6–20 орон) эсвэл MN-ээр эхэлсэн IBAN (MN + 18 цифр)', 'bad_account');
  if (accountName.length < 2) throw badRequest('Дансны эзний нэрийг бичнэ үү', 'name_required');
  if (reason.length < 5) throw badRequest('Буцаах шалтгааныг бичнэ үү', 'reason_required');
  try {
    return await inTx(async (tx) => {
      await bankLock(tx);
      const t = await target(tx, kind, id);
      const r = await tx.refundRequest.create({ data: { kind, bankTransactionId: t.txId, orderId: t.orderId, orderNumber: t.orderNumber, amount: t.amount, bankName, accountNo, accountName, reason, requestedById: actor.id, requestedByName: actor.name } });
      await writeAudit(actor, 'bank.refund_requested', 'RefundRequest', String(r.id), { kind, txId: t.txId, order: t.orderNumber, amount: t.amount, bankName, accountNo, accountName, reason }, tx, ['money', 'bank']);
      alertCache = null;
      return { id: r.id, amount: t.amount };
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('Энэ мөнгөнд буцаах хүсэлт аль хэдийн илгээгдсэн (хүлээгдэж байна)', 'duplicate');
    throw e;
  }
}

/** «Буцаасан» — Супер админ / Нягтлан. Одоо байгаа буцаалтын аргаар эцэслэнэ (болиулахгүй) */
export async function completeRefundRequest(actor: UserActor, idIn: unknown) {
  if (!canDecideRefund(actor.roles)) throw forbidden('Зөвхөн Супер админ, Нягтлан');
  const id = Number(idIn);
  const r = await inTx(async (tx) => {
    await bankLock(tx);
    await tx.$executeRaw`SELECT 1 FROM "RefundRequest" WHERE id = ${id} FOR UPDATE`;
    const q = await tx.refundRequest.findUnique({ where: { id } });
    if (!q) throw notFound('Хүсэлт олдсонгүй');
    if (q.status !== 'PENDING') throw conflict('Энэ хүсэлтийг аль хэдийн шийдсэн', 'decided');
    const kind = q.kind as RefundKind;
    const cur = await target(tx, kind, kind === 'TX' || kind === 'EXCESS' ? q.bankTransactionId! : q.orderId!);
    const extra = { refundRequestId: q.id, bankName: q.bankName, accountNo: q.accountNo, accountName: q.accountName };
    if (kind === 'TX') await setRefundedIn(tx, actor, q.bankTransactionId!, extra);
    else if (kind === 'EXCESS') await refundExcessIn(tx, actor, q.bankTransactionId!, extra);
    else if (kind === 'ORDER_EXCESS') await refundManualExcessIn(tx, actor, q.orderId!, extra);
    else await paidCancelReviewIn(tx, actor, q.orderId!, `Мөнгө буцаасан: ${q.bankName} ${q.accountNo} (${q.accountName}), ${cur.amount.toLocaleString('en-US')}₮`, extra);
    await tx.refundRequest.update({ where: { id }, data: { status: 'DONE', amount: cur.amount, decidedByName: actor.name, decidedAt: new Date() } });
    await writeAudit(actor, 'bank.refund_done', 'RefundRequest', String(id), { kind, amount: cur.amount, requestedAmount: q.amount, order: q.orderNumber, txId: q.bankTransactionId, accountNo: q.accountNo }, tx, ['money', 'bank']);
    alertCache = null;
    return { ok: true, amount: cur.amount };
  });
  bustCounts();
  return r;
}

export async function rejectRefundRequest(actor: UserActor, idIn: unknown, noteIn: unknown) {
  if (!canDecideRefund(actor.roles)) throw forbidden('Зөвхөн Супер админ, Нягтлан');
  const id = Number(idIn);
  const note = txt(noteIn, 300);
  if (note.length < 3) throw badRequest('Татгалзсан шалтгааныг бичнэ үү', 'reason_required');
  return inTx(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "RefundRequest" WHERE id = ${id} FOR UPDATE`;
    const q = await tx.refundRequest.findUnique({ where: { id } });
    if (!q) throw notFound('Хүсэлт олдсонгүй');
    if (q.status !== 'PENDING') throw conflict('Энэ хүсэлтийг аль хэдийн шийдсэн', 'decided');
    await tx.refundRequest.update({ where: { id }, data: { status: 'REJECTED', decidedByName: actor.name, decidedAt: new Date(), decisionNote: note } });
    await writeAudit(actor, 'bank.refund_rejected', 'RefundRequest', String(id), { kind: q.kind, amount: q.amount, order: q.orderNumber, txId: q.bankTransactionId, note }, tx, ['money', 'bank']);
    alertCache = null;
    return { ok: true };
  });
}

const PAGE = 25;
export async function listRefundRequests(actor: UserActor, f: { status?: string; page?: number }) {
  if (!canView(actor.roles, 'bank-import')) throw forbidden();
  const status = ['PENDING', 'DONE', 'REJECTED'].includes(String(f.status)) ? String(f.status) : 'PENDING';
  const page = Math.max(1, Math.min(1000, Math.floor(Number(f.page) || 1)));
  const where = { status };
  const [items, total, counts] = await Promise.all([
    db.refundRequest.findMany({ where, orderBy: { id: status === 'PENDING' ? 'asc' : 'desc' }, skip: (page - 1) * PAGE, take: PAGE }),
    db.refundRequest.count({ where }),
    db.refundRequest.groupBy({ by: ['status'], _count: true }),
  ]);
  const txs = await db.bankTransaction.findMany({ where: { id: { in: items.map((i) => i.bankTransactionId).filter((x): x is number => !!x) } }, select: { id: true, txDate: true, amount: true } });
  const tm = new Map(txs.map((t) => [t.id, t]));
  return {
    page, total, pages: Math.max(1, Math.ceil(total / PAGE)), canDecide: canDecideRefund(actor.roles),
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count])) as Record<string, number>,
    items: items.map((i) => ({ ...i, kindLabel: REFUND_KIND_LABEL[i.kind as RefundKind] ?? i.kind, tx: i.bankTransactionId ? tm.get(i.bankTransactionId) ?? null : null })),
  };
}

/** Бүх хуудасны дээд талд — Супер админ, Нягтлан: хүлээгдэж буй буцаах хүсэлт */
let alertCache: { at: number; n: number } | null = null;
export async function refundRequestAlert(roles: Parameters<typeof canDecideRefund>[0]): Promise<{ count: number } | null> {
  if (!canDecideRefund(roles)) return null;
  if (!alertCache || Date.now() - alertCache.at > (process.env.NODE_ENV === 'test' ? 0 : 30_000)) {
    alertCache = { at: Date.now(), n: await db.refundRequest.count({ where: { status: 'PENDING' } }) };
  }
  return alertCache.n ? { count: alertCache.n } : null;
}
