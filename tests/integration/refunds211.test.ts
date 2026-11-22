import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Role } from '@prisma/client';
import type { UserActor } from '@/lib/services/users';
import { resetDb } from '../helpers/reset';

/** #211 — мөнгө буцаах хүсэлт: оператор бичнэ, СА / нягтлан эцэслэнэ эсвэл татгалзана */
let db: typeof import('@/lib/db').db;
let P: typeof import('@/lib/services/products');
let W: typeof import('@/lib/services/stock/warehouses');
let D: typeof import('@/lib/services/stock/docs');
let O: typeof import('@/lib/services/orders/orders');
let A: typeof import('@/lib/services/orders/admin');
let B: typeof import('@/lib/services/accounting/bank');
let R: typeof import('@/lib/services/accounting/refunds');
beforeAll(async () => {
  process.env.DISABLE_JOBS = '1';
  db = (await import('@/lib/db')).db;
  P = await import('@/lib/services/products'); W = await import('@/lib/services/stock/warehouses'); D = await import('@/lib/services/stock/docs');
  O = await import('@/lib/services/orders/orders'); A = await import('@/lib/services/orders/admin');
  B = await import('@/lib/services/accounting/bank'); R = await import('@/lib/services/accounting/refunds');
});
let seq = 0; let gm = 0;
async function actor(roles: Role[]): Promise<UserActor> {
  seq++;
  const u = await db.user.create({ data: { phone: String(74600000 + seq), name: `${roles.join('+')} ${seq}`, roles, passwordHash: 'x' } });
  return { id: u.id, name: u.name, roles: u.roles, ip: '127.0.0.1' };
}
const gmail = (description: string, amount: number, phone: string | null = null) => B.importTransactions({ id: null, name: 'Gmail' }, [{ date: new Date(), description, amount, phone, emailMessageId: `t211-${++gm}` }], 'GMAIL');
let sa: UserActor, op: UserActor, acc: UserActor, page1: number, v1: number;
const ub = (over: Record<string, unknown> = {}) => ({ phone: '99112233', province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: 13, addressDetail: 'Нарны 45', pageId: page1, lines: [{ variantId: v1, qty: 1 }], idemKey: randomUUID(), prepaidWait: true, ...over });
const form = { bankName: 'Хаан банк', accountNo: '5012 345 678', accountName: 'Бат Болд', reason: 'Үйлчлүүлэгч мөнгөө буцааж авна' };
beforeEach(async () => {
  await resetDb(db as never);
  sa = await actor(['SUPER_ADMIN']); op = await actor(['OPERATOR']); acc = await actor(['ACCOUNTING']);
  page1 = (await A.savePage(sa, { name: 'Шоп' })).id;
  const p = await P.createProduct(sa, { code: 'G1', name: 'Бараа', price: 50000 });
  v1 = p.variants[0]!.id;
  const wh = await W.createWarehouse(sa, { name: 'Төв агуулах' });
  await D.createReceipt(sa, { warehouseId: wh.id, lines: [{ variantId: v1, qty: 50 }], idemKey: randomUUID() });
});

describe('#211 мөнгө буцаах хүсэлт', () => {
  it('таараагүй гүйлгээ: оператор хүсэлт → давхар хүсэлт болохгүй → нягтлан «Буцаасан» → гүйлгээ буцаасан, түүхэнд данс', async () => {
    await gmail('хэн нэгний шилжүүлэг', 30000);
    const t = await db.bankTransaction.findFirstOrThrow({ where: { status: 'UNMATCHED' } });
    await expect(R.createRefundRequest(op, { kind: 'TX', id: t.id, ...form, accountNo: '12ab' })).rejects.toMatchObject({ code: 'bad_account' });
    await expect(R.createRefundRequest(op, { kind: 'TX', id: t.id, ...form, reason: '' })).rejects.toMatchObject({ code: 'reason_required' });
    await expect(R.createRefundRequest(acc, { kind: 'TX', id: t.id, ...form })).rejects.toMatchObject({ status: 403 });
    const r = await R.createRefundRequest(op, { kind: 'TX', id: t.id, ...form });
    expect(r.amount).toBe(30000);
    await expect(R.createRefundRequest(await actor(['OPERATOR_LEAD']), { kind: 'TX', id: t.id, ...form })).rejects.toMatchObject({ code: 'duplicate' });
    // жагсаалтын мөрөнд хүлээгдэж буй хүсэлт харагдана; СА / нягтланд сануулга
    const l = await B.listTransactions(op, { tab: 'UNMATCHED' });
    expect(l.items[0]!.refundReq).toMatchObject({ accountNo: '5012345678', requestedByName: op.name });
    expect(await R.refundRequestAlert(['ACCOUNTING'])).toEqual({ count: 1 });
    expect(await R.refundRequestAlert(['OPERATOR'])).toBeNull();
    await expect(R.completeRefundRequest(op, r.id)).rejects.toMatchObject({ status: 403 });
    await R.completeRefundRequest(acc, r.id);
    expect((await db.bankTransaction.findUniqueOrThrow({ where: { id: t.id } })).refunded).toBe(true);
    expect((await db.refundRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('DONE');
    const au = await db.auditLog.findFirstOrThrow({ where: { action: 'bank.refunded', entityId: String(t.id) } });
    expect(au.details).toMatchObject({ accountNo: '5012345678', refundRequestId: r.id });
    await expect(R.completeRefundRequest(sa, r.id)).rejects.toMatchObject({ code: 'decided' });
    expect(await R.refundRequestAlert(['SUPER_ADMIN'])).toBeNull();
  });

  it('татгалзвал шалтгаантай; дахин хүсэлт илгээж болно; мөнгө хөдлөхгүй', async () => {
    await gmail('шилжүүлэг', 20000);
    const t = await db.bankTransaction.findFirstOrThrow({ where: { status: 'UNMATCHED' } });
    const r = await R.createRefundRequest(op, { kind: 'TX', id: t.id, ...form });
    await expect(R.rejectRefundRequest(sa, r.id, '')).rejects.toMatchObject({ code: 'reason_required' });
    await R.rejectRefundRequest(sa, r.id, 'Дансны дугаар буруу');
    expect((await db.bankTransaction.findUniqueOrThrow({ where: { id: t.id } })).refunded).toBe(false);
    const rj = await R.listRefundRequests(op, { status: 'REJECTED' });
    expect(rj.items[0]).toMatchObject({ decisionNote: 'Дансны дугаар буруу', decidedByName: sa.name });
    expect(rj.canDecide).toBe(false);
    await R.createRefundRequest(op, { kind: 'TX', id: t.id, ...form, accountNo: 'MN123456789012345678' });
    expect((await R.listRefundRequests(acc, {})).counts).toEqual({ PENDING: 1, REJECTED: 1 });
  });

  it('илүү төлөлт: дүнг систем тооцно; эцэслэхэд «Илүүг буцаасан»-тай ижил (төлсөн = дүн)', async () => {
    const o = (await O.createOrder(op, ub())).order;
    await gmail('99112233 төлбөр', 60000, '99112233');
    const t = await db.bankTransaction.findFirstOrThrow({ where: { orderId: o.id } });
    expect(t.status).toBe('EXCESS_AMOUNT');
    await expect(R.createRefundRequest(op, { kind: 'TX', id: t.id, ...form })).rejects.toMatchObject({ code: 'linked' });
    const r = await R.createRefundRequest(op, { kind: 'EXCESS', id: t.id, ...form });
    const ex = r.amount;
    expect(ex).toBeGreaterThan(0);
    await R.completeRefundRequest(sa, r.id);
    const t2 = await db.bankTransaction.findUniqueOrThrow({ where: { id: t.id } });
    expect([t2.status, t2.excessRefunded]).toEqual(['MATCHED', ex]);
  });
});
