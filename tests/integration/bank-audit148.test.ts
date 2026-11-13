import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Role } from '@prisma/client';
import type { UserActor } from '@/lib/services/users';
import { resetDb } from '../helpers/reset';

let db: typeof import('@/lib/db').db;
let P: typeof import('@/lib/services/products');
let W: typeof import('@/lib/services/stock/warehouses');
let D: typeof import('@/lib/services/stock/docs');
let O: typeof import('@/lib/services/orders/orders');
let A: typeof import('@/lib/services/orders/admin');
let B: typeof import('@/lib/services/accounting/bank');
let GM: typeof import('@/lib/services/accounting/gmail');
beforeAll(async () => {
  process.env.DISABLE_JOBS = '1';
  db = (await import('@/lib/db')).db;
  P = await import('@/lib/services/products'); W = await import('@/lib/services/stock/warehouses'); D = await import('@/lib/services/stock/docs');
  O = await import('@/lib/services/orders/orders'); A = await import('@/lib/services/orders/admin');
  B = await import('@/lib/services/accounting/bank'); GM = await import('@/lib/services/accounting/gmail');
});
let seq = 0;
let gm = 0;
const gmail = (description: string, amount: number, phone: string | null = null, id?: string) => B.importTransactions({ id: null, name: 'Gmail' }, [{ date: new Date(), description, amount, phone, emailMessageId: id ?? `t148-${++gm}` }], 'GMAIL');
async function actor(roles: Role[]): Promise<UserActor> {
  seq++;
  const u = await db.user.create({ data: { phone: String(74500000 + seq), name: `${roles.join('+')} ${seq}`, roles, passwordHash: 'x' } });
  return { id: u.id, name: u.name, roles: u.roles, ip: '127.0.0.1' };
}
let sa: UserActor, op: UserActor, acc: UserActor, page1: number, v1: number;
const key = () => randomUUID();
const ub = (over: Record<string, unknown> = {}) => ({ phone: '99112233', province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: 13, addressDetail: 'Нарны 45', pageId: page1, lines: [{ variantId: v1, qty: 1 }], idemKey: key(), prepaidWait: true, ...over });
beforeEach(async () => {
  await resetDb(db as never);
  sa = await actor(['SUPER_ADMIN']); op = await actor(['OPERATOR']); acc = await actor(['ACCOUNTING']);
  page1 = (await A.savePage(sa, { name: 'Шоп' })).id;
  const p = await P.createProduct(sa, { code: 'G1', name: 'Бараа', price: 50000 });
  v1 = p.variants[0]!.id;
  const wh = await W.createWarehouse(sa, { name: 'Төв агуулах' });
  await D.createReceipt(sa, { warehouseId: wh.id, lines: [{ variantId: v1, qty: 50 }], idemKey: key() });
});

/** Аудит #148 — банкны импорт: хуурамч мэйл, утгын дүн, давхар мөнгө, буцаасан илүү, утас солих, давхардал, нууцлал */
describe('#148 банкны импорт', () => {
  it('утга дотор «Khan Bank ORLOGO:500,000» гэж бичсэн 100₮ → 100₮ (хоёр дахь гүйлгээ үүсэхгүй)', async () => {
    const ps = B.parseKhanMessages('Khan Bank:Tany 5***2327 dansand ORLOGO:100.00MNT orj ULDEGDEL:1,000.00MNT bolloo.Utga:Khan Bank ORLOGO:500,000.00MNT Utga:99112233');
    expect(ps.map((x) => [x.amount, x.phone])).toEqual([[100, '99112233']]);
    expect(B.parseKhanMessage('Khan Bank: 5102xxxx dansand 100.00 MNT orlogo orson. Guilgeenii utga: 99112233 ORLOGO:500000MNT')?.amount).toBe(100);
  });

  it('хуурамч мэйл: зөвхөн тохируулсан илгээгч + баталгаажсан мэйл; илгээгчгүй бол татахгүй', async () => {
    const o = (await O.createOrder(op, ub())).order;
    expect(GM.authPass('mx.google.com; dkim=pass header.i=@khanbank.com header.s=s1; spf=pass smtp.mailfrom=info@khanbank.com; dmarc=pass', 'info@khanbank.com')).toBe(true);
    expect(GM.authPass('mx.google.com; dkim=pass header.i=@gmail.com; spf=pass smtp.mailfrom=attacker@gmail.com', 'info@khanbank.com')).toBe(false);
    expect(GM.authPass('mx.google.com; dkim=pass header.i=@khanbank.com; dmarc=fail', 'info@khanbank.com')).toBe(false);
    await db.appSetting.upsert({ where: { key: 'bank.gmail' }, create: { key: 'bank.gmail', value: { email: 'shop@gmail.com', passwordEnc: GM.encrypt('abcdefghijklmnop'), sender: '' } }, update: { value: { email: 'shop@gmail.com', passwordEnc: GM.encrypt('abcdefghijklmnop'), sender: '' } } });
    await expect(GM.gmailSync(sa)).rejects.toMatchObject({ code: 'gmail_not_configured' });
    await GM.setGmailSettings(sa, { email: 'shop@gmail.com', sender: 'info@khanbank.com' });
    GM._setMailFetcher(async () => [
      { id: 'x1', date: new Date(), from: 'attacker@gmail.com', authOk: true, text: 'Hi\nKhan Bank: ORLOGO:50000MNT Utga:99112233' },
      { id: 'x2', date: new Date(), from: 'info@khanbank.com', authOk: false, text: 'Khan Bank: ORLOGO:50000MNT Utga:99112233' },
    ]);
    try {
      const r = await GM.gmailSync(sa);
      expect([r.imported, r.rejected]).toEqual([0, 2]);
      expect((await db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('PENDING_PAYMENT');
    } finally { GM._setMailFetcher(null); }
  });

  it('дахин ирсэн (дугааргүй) ижил гүйлгээ — нөгөө хүлээгдэж буй захиалгыг төлөхгүй, «Давхардсан» (шалтгаантайгаар л тааруулна)', async () => {
    const a = (await O.createOrder(op, ub())).order;
    await B.importTransactions({ id: null, name: 'x' }, [{ date: new Date(), description: '99112233 төлбөр', amount: 50000, phone: '99112233' }], 'GMAIL');
    expect((await db.order.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('NEW');
    await db.order.update({ where: { id: a.id }, data: { status: 'DELIVERED' } }); // эхнийх хүргэгдсэн — тэр үйлчлүүлэгч дахин захиална
    const b = (await O.createOrder(op, ub())).order;
    const r = await B.importTransactions({ id: null, name: 'x' }, [{ date: new Date(), description: '99112233 төлбөр', amount: 50000, phone: '99112233' }], 'GMAIL');
    expect([r.imported, r.duplicates]).toEqual([0, 1]);
    expect((await db.order.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('PENDING_PAYMENT');
    const dup = await db.bankTransaction.findFirstOrThrow({ where: { isDuplicate: true } });
    await expect(B.manualMatch(acc, dup.id, { orderNumber: b.number })).rejects.toMatchObject({ code: 'duplicate_note' });
    await B.manualMatch(acc, dup.id, { orderNumber: b.number, note: 'Хоёр дахь удаагаа тусдаа шилжүүлсэн' });
    const au = await db.auditLog.findFirstOrThrow({ where: { action: 'bank.manual_match' } });
    expect(JSON.stringify(au.details)).toContain('duplicateOf');
    expect((await db.auditLog.findFirstOrThrow({ where: { action: 'bank.imported' } })).details).toHaveProperty('rows');
  });

  it('цуцалсан захиалгын буцаасан илүү мөнгийг шинэ захиалгад дахин тоолохгүй', async () => {
    const a = (await O.createOrder(op, ub())).order; // 50,000
    await gmail('99112233', 80000, '99112233');
    const t = await db.bankTransaction.findFirstOrThrow();
    await B.refundExcess(acc, t.id); // 30,000 буцаасан — үлдсэн 50,000
    await O.cancelOrder(sa, a.id, { reason: 'CUSTOMER_CANCELLED', note: 'болив болив' });
    const b = (await O.createOrder(op, ub({ lines: [{ variantId: v1, qty: 2 }] }))).order; // 100,000
    const bb = await db.order.findUniqueOrThrow({ where: { id: b.id } });
    expect(bb.status).toBe('PENDING_PAYMENT');
    const p = await B.searchOrdersForMatch(acc, b.number);
    void p;
    const s = await db.bankTransaction.aggregate({ where: { orderId: b.id }, _sum: { amount: true, excessRefunded: true } });
    expect((s._sum.amount ?? 0) - (s._sum.excessRefunded ?? 0)).toBe(50000);
  });

  it('утас солиход: зөвхөн сүүлийн 24 цагийн мөнгө автоматаар; хуучныг гараар; хэн солисон түүхэнд', async () => {
    await gmail('88776655 Бат', 50000, '88776655');
    await db.bankTransaction.updateMany({ data: { txDate: new Date(Date.now() - 3 * 86_400_000) } }); // 3 хоногийн өмнөх
    const mine = (await O.createOrder(op, ub({ phone: '99001122' }))).order;
    await O.updateOrder(op, mine.id, { extraPhone: '88776655', version: mine.version } as never);
    expect((await db.order.findUniqueOrThrow({ where: { id: mine.id } })).status).toBe('PENDING_PAYMENT');
    // шинэ мөнгө (24 цагт) — мөнгөө шилжүүлээд дараа нь захиалга үүсгэх хэвийн урсгал
    await gmail('77665544 Дорж', 50000, '77665544');
    const o2 = (await O.createOrder(op, ub({ phone: '77665544' }))).order;
    expect((await db.order.findUniqueOrThrow({ where: { id: o2.id } })).status).toBe('NEW');
    const au = await db.auditLog.findFirstOrThrow({ where: { action: 'bank.auto_match_after_edit' } });
    expect(au.actorName).toBe(op.name);
  });

  it('оператор (харах эрх) таараагүй мөнгийн утас, утгыг харахгүй, хайхгүй, татахгүй', async () => {
    await gmail('88776655 Бат', 50000, '88776655');
    const l = await B.listTransactions(op, {});
    expect(l.items[0]!.phone).toBe('88****55');
    expect(l.items[0]!.description).not.toContain('Бат');
    expect((await B.listTransactions(acc, {})).items[0]!.phone).toBe('88776655');
    await expect(B.exportCsv(op, {})).rejects.toMatchObject({ status: 403 });
    expect((await B.listTransactions(op, { q: '88776655', page: 999 })).page).toBe(200);
  });
});
