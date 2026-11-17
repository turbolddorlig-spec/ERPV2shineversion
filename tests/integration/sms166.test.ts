import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Role } from '@prisma/client';
import { AppError } from '@/lib/errors';
import type { UserActor } from '@/lib/services/users';
import { resetDb } from '../helpers/reset';

/** #166 «Төлбөр хүлээж буй» захиалгын SMS — жинхэнэ SMS явуулахгүй (fetch хуурамч) */
let db: typeof import('@/lib/db').db;
let P: typeof import('@/lib/services/products');
let W: typeof import('@/lib/services/stock/warehouses');
let D: typeof import('@/lib/services/stock/docs');
let O: typeof import('@/lib/services/orders/orders');
let A: typeof import('@/lib/services/orders/admin');
let S: typeof import('@/lib/services/orders/sms');

beforeAll(async () => {
  process.env.DISABLE_JOBS = '1';
  db = (await import('@/lib/db')).db;
  P = await import('@/lib/services/products');
  W = await import('@/lib/services/stock/warehouses');
  D = await import('@/lib/services/stock/docs');
  O = await import('@/lib/services/orders/orders');
  A = await import('@/lib/services/orders/admin');
  S = await import('@/lib/services/orders/sms');
});

let seq = 0;
async function actor(roles: Role[]): Promise<UserActor> {
  seq++;
  const u = await db.user.create({ data: { phone: String(76000000 + seq), name: `${roles.join('+')} ${seq}`, roles, passwordHash: 'x' } });
  return { id: u.id, name: u.name, roles: u.roles, ip: '127.0.0.1' };
}
async function err(p: Promise<unknown>, status: number): Promise<AppError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(AppError); expect((e as AppError).status).toBe(status); return e as AppError; }
  throw new Error(`Алдаа гарах ёстой байсан (${status})`);
}

let sa: UserActor; let admin: UserActor; let op: UserActor; let page1: number; let v1: number;
let phoneSeq = 0;
const order = (over: Record<string, unknown> = {}) => ({
  phone: String(99100000 + ++phoneSeq), province: 'Дархан-Уул', district: 'Дархан', addressDetail: 'Тест хаяг', pageId: page1,
  lines: [{ variantId: v1, qty: 2 }], idemKey: randomUUID(), ...over,
});
type Call = { url: string; body: Record<string, string> };
let calls: Call[] = [];
let reply: () => Response = () => new Response(JSON.stringify({ status: 1, message: '1 мессеж дараалалд орлоо' }), { status: 200 });

beforeEach(async () => {
  await resetDb(db as never);
  sa = await actor(['SUPER_ADMIN']); admin = await actor(['ADMIN']); op = await actor(['OPERATOR']);
  page1 = (await A.savePage(sa, { name: 'Пэйж' })).id;
  const p = await P.createProduct(sa, { code: 'K1', name: 'Хөнгөн куртка', price: 45000, sizes: ['L'] });
  v1 = p.variants[0]!.id;
  const wh = (await W.createWarehouse(sa, { name: 'Төв' })).id;
  await D.createReceipt(sa, { warehouseId: wh, lines: [{ variantId: v1, qty: 100 }], idemKey: randomUUID() });
  calls = [];
  reply = () => new Response(JSON.stringify({ status: 1, message: '1 мессеж дараалалд орлоо' }), { status: 200 });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, body: JSON.parse(String(init.body)) }); return reply(); }));
});
afterEach(() => { vi.unstubAllGlobals(); });

async function configure(over: Record<string, unknown> = {}) {
  return S.setSmsSettings(sa, { bank: 'Хаан банк', account: '5012345678', holder: 'Б.Болд', key: 'KEY-123456', token: 'TOKEN-abcdef', testPhone: '88000001', testMode: false, ...over });
}

describe('#166 SMS', () => {
  it('унтраалттай бол юу ч бичихгүй, захиалга хэвийн', async () => {
    const { order: o } = await O.createOrder(op, order());
    expect(o.status).toBe('PENDING_PAYMENT');
    expect(await db.smsMessage.count()).toBe(0);
  });

  it('асаалттай: «Төлбөр хүлээж буй» үүсэхэд нэг SMS — Латин, 160-д багтана, бодит утгууд', async () => {
    await configure(); await S.setSmsSettings(sa, { enabled: true });
    const { order: o } = await O.createOrder(op, order());
    const m = await db.smsMessage.findUniqueOrThrow({ where: { orderId: o.id } });
    expect(m.phone).toBe(o.phone);
    expect(m.test).toBe(false);
    expect(m.text).toContain(`#${o.number}`);
    expect(m.text).toContain('Hungun kurtka x2');
    expect(m.text).toContain(o.total.toLocaleString('en-US'));
    expect(m.text).toContain('Haan bank 5012345678 B.Bold');
    expect(m.text).toContain(`Guilgeenii utga: ${o.phone}`);
    expect(m.text.length).toBeLessThanOrEqual(160);
    expect(/^[\x20-\x7E]*$/.test(m.text)).toBe(true);
    const r = await S.processSmsQueue();
    expect(r).toEqual({ sent: 1, failed: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(S.SMS_DEFAULT_URL);
    expect(calls[0]!.body).toEqual({ apiKey: 'KEY-123456', apiToken: 'TOKEN-abcdef', phone: o.phone, message: m.text });
    expect((await db.smsMessage.findUniqueOrThrow({ where: { id: m.id } })).status).toBe('SENT');
    // Захиалгын түүхэнд
    expect(await db.auditLog.count({ where: { action: 'order.sms_sent', entityId: String(o.id) } })).toBe(1);
    // Дахин ажиллуулахад давхар явахгүй
    await S.processSmsQueue();
    expect(calls).toHaveLength(1);
    // Захиалгын төлөв, мөнгө өөрчлөгдөөгүй
    const after = await db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(after.status).toBe('PENDING_PAYMENT'); expect(after.total).toBe(o.total); expect(after.paidAmount).toBe(o.paidAmount);
  });

  it('шууд «Шинэ» (УБ, урьдчилгаагүй) захиалгад SMS явахгүй', async () => {
    await configure(); await S.setSmsSettings(sa, { enabled: true });
    await O.createOrder(op, order({ province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: 13 }));
    expect(await db.smsMessage.count()).toBe(0);
  });

  it('туршилтын горим: зөвхөн туршилтын утас руу', async () => {
    await configure({ testMode: true }); await S.setSmsSettings(sa, { enabled: true });
    const { order: o } = await O.createOrder(op, order());
    const m = await db.smsMessage.findUniqueOrThrow({ where: { orderId: o.id } });
    expect(m.phone).toBe('88000001'); expect(m.test).toBe(true);
    await S.processSmsQueue();
    expect(calls[0]!.body.phone).toBe('88000001');
  });

  it('алдаа: захиалга үүснэ, SMS FAILED → дахин оролдоно; үлдэгдэл дууссан анхааруулга', async () => {
    await configure(); await S.setSmsSettings(sa, { enabled: true });
    reply = () => new Response(JSON.stringify({ message: 'Дансны үлдэгдэл хүрэлцэхгүй байна' }), { status: 400 });
    const { order: o } = await O.createOrder(op, order());
    expect(o.id).toBeGreaterThan(0);
    expect(await S.processSmsQueue()).toEqual({ sent: 0, failed: 1 });
    const m = await db.smsMessage.findUniqueOrThrow({ where: { orderId: o.id } });
    expect(m.status).toBe('FAILED'); expect(m.lastError).toContain('үлдэгдэл');
    const al = await S.smsFailAlert();
    expect(al?.count).toBe(1);
    // Дахин илгээх → амжилттай
    reply = () => new Response(JSON.stringify({ status: 1 }), { status: 200 });
    await S.retryFailedSms(sa);
    expect(await S.processSmsQueue()).toEqual({ sent: 1, failed: 0 });
    // 200 боловч status:0 — алдаа гэж тооцно
    reply = () => new Response(JSON.stringify({ status: 0, message: 'API түлхүүр, токен буруу байна' }), { status: 200 });
    const { order: o2 } = await O.createOrder(op, order());
    await S.processSmsQueue();
    expect((await db.smsMessage.findUniqueOrThrow({ where: { orderId: o2.id } })).status).toBe('FAILED');
  });

  it('илгээхээс өмнө цуцлагдсан бол явахгүй (SKIPPED)', async () => {
    await configure(); await S.setSmsSettings(sa, { enabled: true });
    const { order: o } = await O.createOrder(op, order());
    await db.order.update({ where: { id: o.id }, data: { status: 'CANCELLED' } });
    await S.processSmsQueue();
    expect(calls).toHaveLength(0);
    expect((await db.smsMessage.findUniqueOrThrow({ where: { orderId: o.id } })).status).toBe('SKIPPED');
  });

  it('өөрийн текст + урт барааны нэр — багтаана; өөр үйлчилгээний хаяг, JSON', async () => {
    const long = await P.createProduct(sa, { code: 'L1', name: 'Маш урт нэртэй бараа эмэгтэй хүний өвлийн дулаан ноосон пальто хоёр талт капюшонтой', price: 255000, sizes: ['M'] });
    const wh = (await db.warehouse.findFirstOrThrow()).id;
    await D.createReceipt(sa, { warehouseId: wh, lines: [{ variantId: long.variants[0]!.id, qty: 5 }], idemKey: randomUUID() });
    await configure({ template: 'Tany zahialga {дугаар}: {бараа}. Niit {дүн}T. {банк} {данс} ({эзэмшигч}). Utga: {утас}. Tulbur orsny daraa hurgene. Bayarlalaa!',
      url: 'https://sms.example.mn/v2/send', body: '{"auth":{"k":"{key}","t":"{token}"},"to":"{phone}","text":"{message}"}' });
    await S.setSmsSettings(sa, { enabled: true });
    const { order: o } = await O.createOrder(op, order({ lines: [{ variantId: long.variants[0]!.id, qty: 1 }, { variantId: v1, qty: 3 }] }));
    const m = await db.smsMessage.findUniqueOrThrow({ where: { orderId: o.id } });
    expect(m.text.length).toBeLessThanOrEqual(160);
    expect(m.text).toContain('Bayarlalaa!');
    expect(m.text).toContain(`Utga: ${o.phone}`);
    await S.processSmsQueue();
    expect(calls[0]!.url).toBe('https://sms.example.mn/v2/send');
    expect(calls[0]!.body).toEqual({ auth: { k: 'KEY-123456', t: 'TOKEN-abcdef' }, to: o.phone, text: m.text });
  });

  it('эрх: зөвхөн Супер админ; түлхүүр хариунд гарахгүй; буруу утга татгалзана; түүхэнд данс өөрчлөлт', async () => {
    await err(S.getSmsSettings(admin), 403);
    await err(S.setSmsSettings(admin, { account: '999' }), 403);
    await err(S.setSmsSettings(op, { account: '999' }), 403);
    const s = await configure();
    expect(JSON.stringify(s)).not.toContain('KEY-123456');
    expect(JSON.stringify(s)).not.toContain('TOKEN-abcdef');
    expect(s.keyHint).toBe('…3456');
    await err(S.setSmsSettings(sa, { url: 'http://api.sendsms.mn/x' }), 400);
    await err(S.setSmsSettings(sa, { url: 'https://localhost/x' }), 400);
    await err(S.setSmsSettings(sa, { body: '{"to":"{phone}"}' }), 400);
    await err(S.setSmsSettings(sa, { body: 'phone={phone}&m={message}' }), 400);
    await err(S.setSmsSettings(sa, { testPhone: '123' }), 400);
    // Түлхүүрийн талбарт хаяг / JSON загвар андуурч бичихийг татгалзана
    await err(S.setSmsSettings(sa, { key: 'https://api.sendsms.mn/api/user/send' }), 400);
    await err(S.setSmsSettings(sa, { token: '{"apiKey":"{key}","message":"{message}"}' }), 400);
    // Түлхүүргүй асаах боломжгүй
    await db.appSetting.delete({ where: { key: 'smsConfig' } });
    await err(S.setSmsSettings(sa, { enabled: true }), 400);
    await configure({ account: '5099999999' });
    const log = await db.auditLog.findMany({ where: { action: 'settings.sms' }, orderBy: { id: 'asc' } });
    expect(JSON.stringify(log.map((l) => l.details))).not.toContain('KEY-123456');
    expect(JSON.stringify(log.at(-1)!.details)).toContain('5099999999');
  });

  it('#167: өмнө нь буруу хадгалагдсан түлхүүр (хаяг) — илгээхгүй, Тохиргоонд анхааруулга, туршилт татгалзана', async () => {
    await configure(); await S.setSmsSettings(sa, { enabled: true });
    // Хуучин хувилбараар хадгалагдсан буруу утгыг дуурайна
    const row = await db.appSetting.findUniqueOrThrow({ where: { key: 'smsConfig' } });
    const { encrypt } = await import('@/lib/secret');
    await db.appSetting.update({ where: { key: 'smsConfig' }, data: { value: { ...(row.value as object), key: encrypt('https://sms.example.mn/send') } } });
    const st = await S.getSmsSettings(sa);
    expect(st.problems.length).toBe(1);
    expect(st.problems[0]).toContain('apiKey');
    await err(S.testSms(sa), 400);
    const { order: o } = await O.createOrder(op, order());
    await S.processSmsQueue();
    expect(calls).toHaveLength(0);
    const m = await db.smsMessage.findUniqueOrThrow({ where: { orderId: o.id } });
    expect(m.status).toBe('FAILED'); expect(m.lastError).toContain('apiKey');
    // Зөв (хуурамч) түлхүүр оруулахад асуудал арилна, дахин илгээхэд явна
    await S.setSmsSettings(sa, { key: 'DUMMYKEY0000000000000001' });
    expect((await S.getSmsSettings(sa)).problems).toEqual([]);
    await S.retryFailedSms(sa);
    expect(await S.processSmsQueue()).toEqual({ sent: 1, failed: 0 });
  });

  it('Латин хөрвүүлэлт, урт', () => {
    // Хоосон эзэмшигч — « ." үлдэхгүй
    expect(S.renderSms('{банк} {данс} {эзэмшигч}. Utga: {утас}', { bank: 'Khan bank', account: '5100208385', holder: '' }, { number: '1', phone: '88112233', total: 1, lines: [] }).text).toBe('Khan bank 5100208385. Utga: 88112233');
    expect(S.toLatin('Хөнгөн куртка — Хар «L»')).toBe('Hungun kurtka - Har "L"');
    expect(S.toLatin('Цэцэг Ёндон Юу Ямар Шүр Чөлөө Жолооч')).toBe('Tsetseg Yondon Yuu Yamar Shur Chuluu Joloouch'.replace('Joloouch', 'Jolooch'));
    expect(S.smsLimit('abc')).toBe(160);
    expect(S.smsLimit('абв')).toBe(70);
  });
});
