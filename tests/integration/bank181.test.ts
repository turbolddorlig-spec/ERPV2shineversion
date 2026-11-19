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
let SMS: typeof import('@/lib/services/accounting/bank-sms');
beforeAll(async () => {
  process.env.DISABLE_JOBS = '1';
  db = (await import('@/lib/db')).db;
  P = await import('@/lib/services/products'); W = await import('@/lib/services/stock/warehouses'); D = await import('@/lib/services/stock/docs');
  O = await import('@/lib/services/orders/orders'); A = await import('@/lib/services/orders/admin');
  B = await import('@/lib/services/accounting/bank'); GM = await import('@/lib/services/accounting/gmail'); SMS = await import('@/lib/services/accounting/bank-sms');
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
const ORIGIN = 'https://erp.example.mn';
const IN = (acc: string, amount: string, bal: string, utga: string) => `Khan Bank:Tany 5***${acc} dansand ORLOGO:${amount}MNT orj ULDEGDEL:${bal}MNT bolloo.Utga:${utga}`;
const keyOf = async () => new URL((await SMS.getIncomingSettings(sa, ORIGIN)).url!).searchParams.get('key')!;

/** #181 Банкны орлого утаснаас шууд (MacroDroid) + дансны шүүлтүүр + Gmail-тэй давхардахгүй */
describe('#181 утаснаас шууд', () => {
  it('мессеж задлах: данс, үлдэгдэл; OTP / мэдээлэл / зарлага алгасна', () => {
    const p = B.parseKhanMessage(IN('4242', '5,000.00', '6,000.00', 'test'))!;
    expect([p.income, p.amount, p.account, p.fingerprint]).toEqual([true, 5000, '4242', 'khan:4242:5000:in:600000']);
    expect(B.parseKhanMessage('Khan Bank:Huselt batalgaajuulah neg udaagiin nuuts ug: 906534')).toBeNull();
    expect(B.parseKhanMessage('Khan Bank:Tany medeelel amjilttai shinechlegdlee. Lavlah:1800-1917')).toBeNull();
    expect(B.parseKhanMessage('Khan Bank:Tany 5***8385 dansand ZARLAGA:5,000.00MNT garch ULDEGDEL:2,172,102.54MNT bolloo.Utga:test')!.income).toBe(false);
    expect(B.accountAllowed({ account: '4242' }, [])).toBe(true);
    expect(B.accountAllowed({ account: '4242' }, ['8385'])).toBe(false);
    expect(B.accountAllowed({ account: null }, ['8385'])).toBe(false);
  });

  it('түлхүүр: идэвхгүй/буруу → 401; зөвхөн Супер админ тохируулна; солиход хуучин ажиллахгүй', async () => {
    expect((await SMS.receiveSms('x', IN('4242', '5,000.00', '6,000.00', '99112233'))).status).toBe(401);
    await expect(SMS.getIncomingSettings(acc, ORIGIN)).rejects.toMatchObject({ status: 403 });
    await expect(SMS.rotateKey(acc)).rejects.toMatchObject({ status: 403 });
    await SMS.rotateKey(sa);
    const k1 = await keyOf();
    expect((await SMS.getIncomingSettings(sa, ORIGIN)).url).toMatch(/^https:\/\/erp\.example\.mn\/api\/bank\/sms\?key=/);
    expect((await SMS.receiveSms(k1 + 'x', 'Khan Bank')).status).toBe(401);
    expect((await SMS.receiveSms(k1, 'Khan Bank:Huselt batalgaajuulah neg udaagiin nuuts ug: 906534')).body.result).toContain('алгаслаа');
    await SMS.rotateKey(sa);
    expect((await SMS.receiveSms(k1, 'Khan Bank')).status).toBe(401);
    const s = await SMS.getIncomingSettings(sa, ORIGIN);
    expect([s.count, s.rejected >= 2]).toEqual([1, true]);
    await SMS.disableSms(sa);
    expect((await SMS.getIncomingSettings(sa, ORIGIN)).url).toBeNull();
    const row = await db.appSetting.findUniqueOrThrow({ where: { key: 'bank.incoming' } });
    expect(JSON.stringify(row.value)).not.toContain(k1);
  });

  it('ORLOGO → захиалга шууд «Мөнгө орсон» (Gmail шиг); зарлага, өөр данс алгасна; Gmail-ээр дахин ирсэн ч нэг л удаа', async () => {
    const o = (await O.createOrder(op, ub())).order;
    await SMS.rotateKey(sa);
    const k = await keyOf();
    await expect(SMS.setAccounts(sa, '42a')).rejects.toMatchObject({ code: 'bad_account' });
    await SMS.setAccounts(sa, '4242, 1111');
    expect((await SMS.receiveSms(k, 'Khan Bank:Tany 5***4242 dansand ZARLAGA:5,000.00MNT garch ULDEGDEL:1.00MNT bolloo.Utga:99112233')).body.result).toBe('Зарлага — алгаслаа');
    expect((await SMS.receiveSms(k, IN('8385', String(o.total), '9,999.00', '99112233'))).body.result).toContain('Өөр данс');
    expect(await db.bankTransaction.count()).toBe(0);
    const msg = IN('4242', `${o.total.toLocaleString('en-US')}.00`, '123,456.00', '99112233');
    const r = await SMS.receiveSms(k, msg);
    expect(r.body.result).toContain('Мөнгө орсон');
    expect((await db.order.findUniqueOrThrow({ where: { id: o.id } })).status).not.toBe('PENDING_PAYMENT');
    expect((await db.bankTransaction.findFirstOrThrow()).source).toBe('SMS');
    // Ижил мессеж дахин (утас давтан илгээсэн) эсвэл Gmail-ээр ирсэн — нэг л удаа
    expect((await SMS.receiveSms(k, msg)).body.result).toContain('Өмнө орсон');
    await GM.setGmailSettings(sa, { email: 'shop@gmail.com', sender: 'info@khanbank.com', appPassword: 'abcdefghijklmnop' });
    GM._setMailFetcher(async () => [
      { id: 'm1', date: new Date(), from: 'info@khanbank.com', authOk: true, text: msg },
      { id: 'm2', date: new Date(), from: 'info@khanbank.com', authOk: true, text: IN('8385', '7,000.00', '1.00', '99112233') }, // өөр данс
    ]);
    try {
      const g = await GM.gmailSync(sa);
      expect([g.imported, g.duplicates, g.skipped]).toEqual([0, 1, 1]);
    } finally { GM._setMailFetcher(null); }
    expect(await db.bankTransaction.count()).toBe(1);
    // Данс солих (барьцаа / гацсан): 8385 болговол тэр дансны орлого орно
    await SMS.setAccounts(sa, '8385');
    expect((await SMS.receiveSms(k, IN('8385', '7,000.00', '2.00', '88001122'))).body.result).toContain('таараагүй');
    expect(await db.auditLog.count({ where: { action: 'settings.bank_accounts' } })).toBe(2);
  });
});
