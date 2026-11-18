import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Role } from '@prisma/client';
import { AppError } from '@/lib/errors';
import type { UserActor } from '@/lib/services/users';
import { resetDb } from '../helpers/reset';
import { bankPay } from '../helpers/bankPay';

/** #173 — тасархай захиалга (ахлах жолооч), банкны тохиргоо/экспорт эрх, барааны гарцын мөнгө зөвхөн СА, хувилбарын пэйж */
let db: typeof import('@/lib/db').db;
let P: typeof import('@/lib/services/products');
let W: typeof import('@/lib/services/stock/warehouses');
let D: typeof import('@/lib/services/stock/docs');
let V: typeof import('@/lib/services/stock/views');
let O: typeof import('@/lib/services/orders/orders');
let A: typeof import('@/lib/services/orders/admin');
let L: typeof import('@/lib/services/delivery/assign');
let H: typeof import('@/lib/services/delivery/handover');
let U: typeof import('@/lib/ubdate');
let DR: typeof import('@/lib/services/delivery/driver');
let G: typeof import('@/lib/services/delivery/goods');

beforeAll(async () => {
  process.env.DISABLE_JOBS = '1';
  db = (await import('@/lib/db')).db;
  P = await import('@/lib/services/products');
  W = await import('@/lib/services/stock/warehouses');
  D = await import('@/lib/services/stock/docs');
  V = await import('@/lib/services/stock/views');
  O = await import('@/lib/services/orders/orders');
  A = await import('@/lib/services/orders/admin');
  L = await import('@/lib/services/delivery/assign');
  H = await import('@/lib/services/delivery/handover');
  U = await import('@/lib/ubdate');
  DR = await import('@/lib/services/delivery/driver');
  G = await import('@/lib/services/delivery/goods');
});

let seq = 0;
async function actor(roles: Role[]): Promise<UserActor> {
  seq++;
  const u = await db.user.create({ data: { phone: String(75000000 + seq), name: `${roles.join('+')} ${seq}`, roles, passwordHash: 'x' } });
  return { id: u.id, name: u.name, roles: u.roles, ip: '127.0.0.1' };
}
async function err(p: Promise<unknown>, status: number, code?: string): Promise<AppError> {
  try { await p; } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).status).toBe(status);
    if (code) expect((e as AppError).code).toBe(code);
    return e as AppError;
  }
  throw new Error(`Алдаа гарах ёстой байсан (${status})`);
}
const key = () => randomUUID();

let sa: UserActor; let op: UserActor; let lead: UserActor; let wh: UserActor; let acc: UserActor; let drv: UserActor; let drv2: UserActor;
let page1: number; let v1: number; let v2: number; let mainWh: number; let wh2: number;
let today: string; let tomorrow: string;
let phoneSeq = 0;
const ub = (over: Record<string, unknown> = {}) => ({
  phone: String(99000000 + ++phoneSeq), province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: 13, addressDetail: 'Тест 45-р байр',
  pageId: page1, lines: [{ variantId: v1, qty: 2 }], idemKey: key(), ...over,
});
const bal = async (locationId: number, variantId: number) => (await db.stockBalance.findUnique({ where: { locationId_variantId: { locationId, variantId } } }))?.qty ?? 0;
const locOf = async (warehouseId: number) => (await db.stockLocation.findUniqueOrThrow({ where: { warehouseId } })).id;
const drvLoc = async (u: UserActor) => (await db.stockLocation.findUnique({ where: { kind_userId: { kind: 'DRIVER', userId: u.id } } }))?.id ?? -1;
async function checkAll(id: number) {
  const d = await H.handoverDetail(wh, id);
  for (const i of d.items) await H.setCheck(wh, id, { variantId: i.variantId, checked: true });
}

beforeEach(async () => {
  await resetDb(db as never);
  sa = await actor(['SUPER_ADMIN']); op = await actor(['OPERATOR']); lead = await actor(['DRIVER_LEAD']); wh = await actor(['WAREHOUSE']);
  acc = await actor(['ACCOUNTING']); drv = await actor(['DRIVER']); drv2 = await actor(['DRIVER']);
  page1 = (await A.savePage(sa, { name: 'Гутал Шоп' })).id;
  const p = await P.createProduct(sa, { code: 'G1', name: 'Гутлын үдээс', price: 10000, sizes: ['S', 'L'] });
  [v1, v2] = p.variants.map((v) => v.id) as [number, number];
  mainWh = (await W.createWarehouse(sa, { name: 'Төв агуулах' })).id; // эхнийх = үндсэн
  wh2 = (await W.createWarehouse(sa, { name: 'Агуулах 2' })).id;
  await D.createReceipt(wh, { warehouseId: mainWh, lines: [{ variantId: v1, qty: 20 }, { variantId: v2, qty: 5 }], idemKey: key() });
  await D.createReceipt(wh, { warehouseId: wh2, lines: [{ variantId: v2, qty: 10 }], idemKey: key() });
  today = U.ubDay(); tomorrow = U.ubDay(new Date(), 1);
  await H.setTrusted(acc, { driverId: drv.id, trusted: true });
});


const dayD = (n: number) => new Date(U.ubDay(new Date(), n) + 'T00:00:00Z');
describe('#173', () => {
  it('тасархай захиалга: 3 нь маргааш, 1 нь өнөөдөр падаангүй → мэдэгдэл; шилжүүлэхэд алга', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) ids.push((await O.createOrder(op, ub({ deliveryDate: tomorrow }))).order.id);
    await L.assignOrders(lead, { ids, driverId: drv.id });
    await db.order.update({ where: { id: ids[0]! }, data: { deliveryDate: dayD(0) } });
    const r = await L.strayOrders(lead);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ driverId: drv.id, mainDate: tomorrow });
    expect(r.items[0]!.orders.map((o) => o.id)).toEqual([ids[0]]);
    await err(L.strayOrders(op), 403);
    await L.setDeliveryDate(lead, { ids: [ids[0]!], date: tomorrow });
    expect((await L.strayOrders(lead)).items).toEqual([]);
    // өнгөрсөн өдөрт үлдсэн
    await db.order.update({ where: { id: ids[1]! }, data: { deliveryDate: dayD(-2) } });
    expect((await L.strayOrders(lead)).items[0]!.orders[0]).toMatchObject({ id: ids[1], reason: 'өнгөрсөн өдөр' });
  });

  it('банкны импорт: Gmail тохиргоо, CSV экспорт — оператор / ахлах оператор харахгүй', async () => {
    const GM = await import('@/lib/services/accounting/gmail');
    const B = await import('@/lib/services/accounting/bank');
    const opLead = await actor(['OPERATOR_LEAD']);
    expect((await GM.gmailStatus(opLead)).settings).toBeNull();
    expect((await GM.gmailStatus(opLead)).canSetup).toBe(false);
    expect((await GM.gmailStatus(acc)).canSetup).toBe(true);
    await err(B.exportCsv(opLead, {} as never), 403);
    expect((await B.listTransactions(opLead, {} as never)).canSetup).toBe(false);
  });

  it('барааны гарц: үнэ, үнэлгээний цалин зөвхөн Супер админд; хувилбараар пэйж', async () => {
    const OF = await import('@/lib/services/outflow');
    const ml = await actor(['MARKETING_LEAD']); const adm = await actor(['ADMIN']); const mk = await actor(['MARKETING']);
    const a = (await O.createOrder(op, ub({ lines: [{ variantId: v1, qty: 1 }] }))).order;
    void a; OF.bustOutflowCache(); OF.bustTable();
    for (const u of [ml, adm, mk]) {
      const t = await OF.outflowTable(u, {});
      expect(t.rows.every((r) => r.price === null)).toBe(true);
    }
    const t = await OF.outflowTable(sa, {});
    expect(t.rows.some((r) => typeof r.price === 'number')).toBe(true);
    const h = await OF.scoreHistory(ml, undefined, undefined);
    expect(h.rows.every((r) => r.salary === null)).toBe(true);
    const pg = await OF.productPages(mk, t.rows[0]!.id, v1);
    expect(pg.pages.length).toBeGreaterThan(0);
    const pg2 = await OF.productPages(mk, t.rows[0]!.id, v2);
    expect(pg2.pages.reduce((s, p) => s + p.total, 0)).toBe(0);
  });
});
