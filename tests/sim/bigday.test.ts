import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Role } from '@prisma/client';
import { AppError } from '@/lib/errors';
import type { UserActor } from '@/lib/services/users';
import { resetDb } from '../helpers/reset';
import { bankPay } from '../helpers/bankPay';

/**
 * #156 Том сценарийн тест (эзний хүсэлт): нэг бүтэн ажлын өдрийг бүх хуудсаар зэрэг ажиллуулж, хуудас хоорондын уялдааг шалгана.
 *  Захиалга (12 оператор зэрэг) → оноох → падаан → хүргэлт/цуцлах/маргааш/асуудал (жолооч бүр зэрэг) → асуудал шийдэх → СА цуцлах →
 *  буцаалт → банк → тооцоо нийлэх → нийлүүлэгч, барааны гарц, нүүр, тайлан, цалин, торгууль, зээл.
 *  Шат бүрийн дараа: үлдэгдэл тулгалт 0 (B2), хасах үлдэгдэлгүй, хуудас бүрийн тоо хоорондоо таарна.
 *  Бүх зөрүүг цуглуулж эцэст нь нэг дор тайлагнана (эхний алдаагаар зогсохгүй).
 */
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
let C: typeof import('@/lib/services/accounting/calc');
let S: typeof import('@/lib/services/accounting/settle');
let B: typeof import('@/lib/services/accounting/bank');
let SP: typeof import('@/lib/services/supplier');
let OF: typeof import('@/lib/services/outflow');
let DSH: typeof import('@/lib/services/dashboard');
let RP: typeof import('@/lib/services/orders/reports');
let SAL: typeof import('@/lib/services/salary');
let PN: typeof import('@/lib/services/penalties');
let LN: typeof import('@/lib/services/stock/loans');

const N_ORDERS = Number(process.env.SIM_ORDERS ?? 240);
const N_DRIVERS = Number(process.env.SIM_DRIVERS ?? 6);
const N_OPS = 12;

// ───────── тусламж ─────────
let seed = 20261114;
const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)]!;
const key = () => randomUUID();
async function pool<T>(items: T[], n: number, fn: (x: T, i: number) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k]!, k); } }));
}
const problems: string[] = [];
const expected: Record<string, number> = {};
const sample: Record<string, string> = {};
const bad = (where: string, msg: string) => { problems.push(`[${where}] ${msg}`); };
/** Хэрэглэгчид ойлгомжтой татгалзал (4xx) — хэвийн; 500 эсвэл AppError биш бол асуудал */
async function act(where: string, fn: () => Promise<unknown>) {
  try { return await fn(); } catch (e) {
    if (e instanceof AppError && e.status < 500) { const k = `${where}:${e.code ?? e.status}`; expected[k] = (expected[k] ?? 0) + 1; sample[k] ??= e.message; return null; }
    bad(where, `ГЭНЭТИЙН АЛДАА: ${(e as Error).message?.slice(0, 300)}`);
    return null;
  }
}
const eq = (where: string, what: string, a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) bad(where, `${what}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); };

let seq = 0;
async function actor(roles: Role[], name?: string): Promise<UserActor> {
  seq++;
  const u = await db.user.create({ data: { phone: String(76000000 + seq), name: name ?? `${roles.join('+')} ${seq}`, roles, passwordHash: 'x' } });
  return { id: u.id, name: u.name, roles: u.roles, ip: '127.0.0.1' };
}

let sa: UserActor; let adm: UserActor; let olead: UserActor; let dlead: UserActor; let wh: UserActor; let acc: UserActor; let mkt: UserActor;
let ops: UserActor[] = []; let drivers: UserActor[] = [];
let pages: number[] = []; let variants: number[] = []; let mainWh = 0; let shop = 0; let shopProducts: number[] = [];
let today = '';

async function checkStock(phase: string) {
  const r = await V.reconcile(sa, { fresh: true });
  if (!r.ok) bad(phase, `ҮЛДЭГДЭЛ ЗӨРЛӨӨ: ${JSON.stringify(r).slice(0, 400)}`);
  const neg = await db.stockBalance.count({ where: { qty: { lt: 0 } } });
  if (neg) bad(phase, `хасах үлдэгдэл ${neg} мөр`);
  // Нөөц = идэвхтэй (агуулахаас гараагүй) захиалгын мөрийн нийлбэр
  const [res] = await db.$queryRaw<{ r: number; need: number }[]>`
    SELECT (SELECT COALESCE(sum(qty),0)::int FROM "StockReservation") AS r,
           (SELECT COALESCE(sum(l.qty),0)::int FROM "OrderLine" l JOIN "Order" o ON o.id = l."orderId" WHERE o.status IN ('NEW','ASSIGNED','PENDING_PAYMENT') AND o.prepaid IS NOT NULL
              AND EXISTS (SELECT 1 FROM "StockReservation" s WHERE s."orderId" = o.id)) AS need`;
  if (res && res.r !== res.need) bad(phase, `нөөцийн нийлбэр ${res.r} ≠ идэвхтэй захиалгын ${res.need}`);
  // Хадгалалт: гадагш гарсан = хүргэсэн захиалгын авсан ширхэг (нэмэлт борлуулалт, зарлага, тооллогогүй сценари)
  const [m] = await db.$queryRaw<{ inq: number; outq: number; bal: number }[]>`
    SELECT (SELECT COALESCE(sum(qty),0)::int FROM "StockMove" WHERE "fromId" IS NULL) AS inq,
           (SELECT COALESCE(sum(qty),0)::int FROM "StockMove" WHERE "toId" IS NULL) AS outq,
           (SELECT COALESCE(sum(qty),0)::int FROM "StockBalance") AS bal`;
  if (m && m.inq - m.outq !== m.bal) bad(phase, `журнал: орсон ${m.inq} − гарсан ${m.outq} ≠ үлдэгдэл ${m.bal}`);
  const [dl] = await db.$queryRaw<{ q: number }[]>`SELECT COALESCE(sum(l.qty - l."refusedQty"),0)::int AS q FROM "OrderLine" l JOIN "Order" o ON o.id = l."orderId" WHERE o.status = 'DELIVERED'`;
  const [mv] = await db.$queryRaw<{ q: number }[]>`SELECT COALESCE(sum(CASE WHEN type = 'DELIVERY' THEN qty WHEN type = 'DELIVERY_BACK' THEN -qty ELSE 0 END),0)::int AS q FROM "StockMove"`;
  if (dl && mv && dl.q !== mv.q) bad(phase, `хүргэсэн захиалгын авсан ширхэг ${dl.q} ≠ журналын хүргэлт ${mv.q}`);
}

/** Жолооч бүр: апп = хяналт = нягтлангийн «Тооцоо» (хүргэсэн, мөнгө); гарт байгаа бараа = хүргэлтэд + буцаах */
async function checkDrivers(phase: string) {
  const day = new Map((await C.computeDay(db, today)).map((d) => [d.driverId, d]));
  const ctl = new Map((await G.driverControl(sa, today)).items.map((x) => [x.id, x]));
  for (const d of drivers) {
    const app = await DR.driverOrders(d, 'delivered');
    const cd = day.get(d.id); const c = ctl.get(d.id);
    eq(`${phase} ${d.name}`, 'апп ↔ тооцоо: хүргэсэн', app.counts.delivered, cd?.delivered ?? 0);
    eq(`${phase} ${d.name}`, 'апп ↔ тооцоо: бэлэн/данс/урьдчилсан', [app.money.cash, app.money.bank, app.money.prepaid], [cd?.cash ?? 0, cd?.bank ?? 0, cd?.prepaidAmount ?? 0]);
    eq(`${phase} ${d.name}`, 'хяналт ↔ тооцоо: хүргэсэн/цуцалсан/маргааш/бэлэн/данс', [c?.delivered ?? 0, c?.cancelled ?? 0, c?.postponed ?? 0, c?.cash ?? 0, c?.bank ?? 0],
      [cd?.delivered ?? 0, (cd?.cancelled ?? 0) + (cd?.excluded ?? 0), cd?.postponed ?? 0, cd?.cash ?? 0, cd?.bank ?? 0]);
    const g = await G.goodsView(d.id);
    const bal = g.items.reduce((n, i) => n + i.balance, 0);
    const [out] = await db.$queryRaw<{ q: number }[]>`SELECT COALESCE(sum(l.qty),0)::int AS q FROM "OrderLine" l JOIN "Order" o ON o.id = l."orderId" WHERE o.status = 'OUT_FOR_DELIVERY' AND o."driverId" = ${d.id}::uuid`;
    const held = g.items.reduce((n, i) => n + i.held, 0); const ret = g.items.reduce((n, i) => n + i.returnable, 0);
    if (held + ret !== bal) bad(`${phase} ${d.name}`, `гарт ${bal} ≠ хүргэлтэд ${held} + буцаах ${ret}`);
    if (held !== (out?.q ?? 0)) bad(`${phase} ${d.name}`, `хүргэлтэд байгаа бараа ${held} ≠ хүргэлтэд гарсан захиалгын ${out?.q ?? 0}`);
    if ((c?.goods ?? 0) !== bal) bad(`${phase} ${d.name}`, `хяналтын «Бараа» ${c?.goods ?? 0} ≠ гарт ${bal}`);
  }
}

beforeAll(async () => {
  process.env.DISABLE_JOBS = '1';
  db = (await import('@/lib/db')).db;
  P = await import('@/lib/services/products'); W = await import('@/lib/services/stock/warehouses'); D = await import('@/lib/services/stock/docs');
  V = await import('@/lib/services/stock/views'); O = await import('@/lib/services/orders/orders'); A = await import('@/lib/services/orders/admin');
  L = await import('@/lib/services/delivery/assign'); H = await import('@/lib/services/delivery/handover'); U = await import('@/lib/ubdate');
  DR = await import('@/lib/services/delivery/driver'); G = await import('@/lib/services/delivery/goods'); C = await import('@/lib/services/accounting/calc');
  S = await import('@/lib/services/accounting/settle'); B = await import('@/lib/services/accounting/bank'); SP = await import('@/lib/services/supplier');
  OF = await import('@/lib/services/outflow'); DSH = await import('@/lib/services/dashboard'); RP = await import('@/lib/services/orders/reports');
  SAL = await import('@/lib/services/salary'); PN = await import('@/lib/services/penalties'); LN = await import('@/lib/services/stock/loans');
  await resetDb(db as never);
  today = U.ubDay();
});

describe('#156 бүтэн ажлын өдөр — бүх хуудсын уялдаа', () => {
  it('сценари + тулгалт', async () => {
    const t0 = Date.now();
    const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
    // ───── 0. Бэлтгэл ─────
    sa = await actor(['SUPER_ADMIN'], 'Эзэн'); adm = await actor(['ADMIN']); olead = await actor(['OPERATOR_LEAD']); dlead = await actor(['DRIVER_LEAD']);
    wh = await actor(['WAREHOUSE']); acc = await actor(['ACCOUNTING']); mkt = await actor(['MARKETING']);
    ops = []; for (let i = 0; i < N_OPS; i++) ops.push(await actor(['OPERATOR'], `Оператор ${i + 1}`));
    drivers = []; for (let i = 0; i < N_DRIVERS; i++) drivers.push(await actor(['DRIVER'], `Жолооч ${i + 1}`));
    for (const n of ['Гутал Шоп', 'Цүнх Шоп', 'Хувцас Шоп']) pages.push((await A.savePage(sa, { name: n })).id);
    mainWh = (await W.createWarehouse(sa, { name: 'Төв агуулах' })).id;
    const prodIds: number[] = [];
    for (let i = 0; i < 15; i++) {
      const p = await P.createProduct(sa, { code: `SIM${i}`, name: `Бараа ${i} ${'урт нэр '.repeat(i % 3)}`, price: 15000 + i * 3000, costPrice: 6000 + i * 1000, ...(i % 3 === 0 ? { colors: ['Хар', 'Цагаан'] } : {}) });
      prodIds.push(p.id); variants.push(...p.variants.map((v) => v.id));
    }
    await D.createReceipt(wh, { warehouseId: mainWh, lines: variants.map((v) => ({ variantId: v, qty: Math.max(40, Math.ceil((N_ORDERS * 3) / variants.length)) })), idemKey: key() });
    for (const d of drivers) await H.setTrusted(acc, { driverId: d.id, trusted: true });
    shop = (await SP.saveShop(adm, { name: 'Нийлүүлэгч А', contactName: 'Бат', contactPhone: '99112233' })).id;
    shopProducts = prodIds.slice(0, 2);
    for (const pid of shopProducts) await SP.assignProduct(adm, { shopId: shop, productId: pid });
    await SP.saveDeduction(sa, { shopId: shop, productId: shopProducts[0], operatorCost: 1000, deliveryCost: 2000, marketingCost: 3000, otherCost: 0 });
    for (const pid of prodIds.slice(0, 5)) await act('бүүст', () => OF.saveBoost(mkt, { productId: pid, zones: 1, dollar: 5 }));
    await checkStock('0 бэлтгэл');
    log('бэлтгэл дууслаа');

    // ───── 1. Захиалга: 12 оператор зэрэг ─────
    let ph = 0;
    const created: number[] = [];
    await pool(Array.from({ length: N_ORDERS }, (_, i) => i), N_OPS, async (i) => {
      const op = ops[i % N_OPS]!;
      const lines = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => ({ variantId: pick(variants), qty: 1 + Math.floor(rnd() * 2) }));
      const uniq = [...new Map(lines.map((l) => [l.variantId, l])).values()];
      const prepaid = rnd() < 0.15;
      const r = await act('захиалга үүсгэх', () => O.createOrder(op, {
        phone: String(88000000 + ++ph), province: 'Улаанбаатар', district: pick(['Баянзүрх', 'Сүхбаатар', 'Хан-Уул']), khoroo: 1 + Math.floor(rnd() * 20),
        addressDetail: i % 17 === 0 ? 'Маш урт хаяг '.repeat(20) : 'Тест байр', pageId: pick(pages), lines: uniq, idemKey: key(), deliveryDate: today, ...(prepaid ? { prepaidWait: true } : {}),
      })) as { order: { id: number; prepaid: boolean; status: string } } | null;
      if (!r) return;
      created.push(r.order.id);
      if (prepaid) await act('банкаар төлөх', () => bankPay(r.order.id));
    });
    // Оператор цуцлах (5%)
    for (const id of created.filter(() => rnd() < 0.05)) {
      const o = await db.order.findUniqueOrThrow({ where: { id } });
      await act('оператор цуцлах', () => O.cancelOrder(ops[0]!.roles.includes('OPERATOR') ? olead : sa, id, { reason: 'CUSTOMER_CANCELLED', note: 'Захиалагч болих гэсэн', version: o.version }));
    }
    log(`захиалга: ${created.length} үүссэн`);
    await checkStock('1 захиалга');

    // ───── 2. Оноох, падаан ─────
    const ready = (await db.order.findMany({ where: { status: 'NEW', deliveryDate: U.dateOnly(today) }, select: { id: true }, orderBy: { id: 'asc' } })).map((o) => o.id);
    const byDriver = new Map<string, number[]>(drivers.map((d) => [d.id, []]));
    ready.forEach((id, i) => byDriver.get(drivers[i % N_DRIVERS]!.id)!.push(id));
    await pool(drivers, N_DRIVERS, async (d) => { const ids = byDriver.get(d.id)!; for (let i = 0; i < ids.length; i += 50) await act('оноох', () => L.assignOrders(dlead, { ids: ids.slice(i, i + 50), driverId: d.id })); });
    await pool(drivers, 3, async (d) => {
      const ids = (await db.order.findMany({ where: { driverId: d.id, status: 'ASSIGNED' }, select: { id: true } })).map((o) => o.id);
      if (!ids.length) return;
      const h = await act('падаан үүсгэх', () => H.createHandover(wh, { driverId: d.id, date: today, orderIds: ids })) as { id: number } | null;
      if (!h) return;
      await act('падаан бэлтгэх', () => H.prepareHandover(wh, h.id));
      const det = await H.handoverDetail(wh, h.id);
      for (const it of det.items) await act('тулгах', () => H.setCheck(wh, h.id, { variantId: it.variantId, checked: true }));
      await act('падаан өгөх', () => H.confirmHandover(wh, h.id));
      await act('жолооч тулгах', () => H.setDriverCheck(d, h.id, { variantId: 'all', checked: true }));
      await act('жолооч хүлээн авах', () => H.receiveHandover(d, h.id));
    });
    log('падаан өгсөн');
    await checkStock('2 падаан');
    await checkDrivers('2 падаан');

    // ───── 3. Жолооч бүр зэрэг: хүргэх / хэсэгчилсэн / цуцлах / маргааш / асуудал ─────
    const issues: number[] = [];
    await pool(drivers, N_DRIVERS, async (d) => {
      const os = await db.order.findMany({ where: { driverId: d.id, status: 'OUT_FOR_DELIVERY' }, include: { lines: true }, orderBy: { id: 'asc' } });
      for (const o of os) {
        const x = rnd();
        if (x < 0.55) await act('хүргэх', () => DR.deliverOrder(d, o.id, { payment: o.prepaid ? undefined : pick(['CASH', 'CASH', 'BANK']), note: o.prepaid ? 'Урьдчилж төлсөн' : undefined, version: o.version }));
        else if (x < 0.65 && o.lines.some((l) => l.qty > 1 || o.lines.length > 1)) {
          const taken = Object.fromEntries(o.lines.map((l, i) => [l.id, i === 0 ? Math.max(1, l.qty - 1) : 0]));
          await act('хэсэгчлэн хүргэх', () => DR.deliverOrder(d, o.id, { payment: o.prepaid ? undefined : 'CASH', taken, note: 'Хэсэгчлэн авсан', version: o.version }));
        } else if (x < 0.75) await act('жолооч цуцлах', () => DR.driverCancel(d, o.id, { note: 'Захиалагч утсаа авахгүй', version: o.version }));
        else if (x < 0.83) await act('маргааш', () => DR.postponeOrder(d, o.id, { version: o.version }));
        else if (x < 0.9) { if (await act('асуудал', () => DR.reportIssue(d, o.id, { type: 'WRONG_NUMBER', note: 'Утас холбогдохгүй' }))) issues.push(o.id); }
        else await act('хүргэх', () => DR.deliverOrder(d, o.id, { payment: o.prepaid ? undefined : 'BANK', note: o.prepaid ? 'Урьдчилж төлсөн' : undefined, version: o.version }));
        // Давхар дарах (өөр утаснаас) — 5%
        if (rnd() < 0.05) await act('давхар хүргэх', () => DR.deliverOrder(d, o.id, { payment: 'CASH', version: o.version }));
      }
    });
    log(`жолооч ажилласан, асуудал ${issues.length}`);
    // Асуудал: 2 ахлах зэрэг (өөр шийдвэр) — нэг нь л амжилттай
    const olead2 = await actor(['OPERATOR_LEAD']);
    await pool(issues, 4, async (id) => {
      await Promise.all([act('асуудал засах', () => DR.resolveIssue(olead, id, { action: 'fix', note: 'Зөв утас олдсон' })), act('асуудал цуцлах', () => DR.resolveIssue(olead2, id, { action: 'cancel', note: 'Захиалагч татгалзсан', fault: 'OPERATOR' }))]);
      const o = await db.order.findUniqueOrThrow({ where: { id } });
      if (o.status === 'OUT_FOR_DELIVERY' && o.driverId) await act('засагдсаныг хүргэх', () => DR.deliverOrder(drivers.find((x) => x.id === o.driverId)!, id, { payment: o.prepaid ? undefined : 'CASH', note: o.prepaid ? 'Урьдчилж төлсөн' : undefined, version: o.version }));
    });
    // СА хүргэснийг цуцлах (2), нягтлан төлөв солих (2)
    const dlv = await db.order.findMany({ where: { status: 'DELIVERED' }, take: 4, orderBy: { id: 'desc' } });
    for (const o of dlv.slice(0, 2)) await act('СА цуцлах', () => O.saCancelOrder(sa, o.id, { reason: 'OTHER', note: 'Үйлчлүүлэгч буцааж өгсөн', version: o.version }));
    for (const o of dlv.slice(2, 4)) await act('нягтлан төлөв солих', () => S.toggleOrderStatus(acc, o.id, { target: 'CANCELLED', note: 'Үйлчлүүлэгч буцаасан' }));
    // Үлдсэн хүргэлтэд гарсныг дуусгана (тооцоо нийлэхийн тулд)
    await pool(drivers, N_DRIVERS, async (d) => {
      for (const o of await db.order.findMany({ where: { driverId: d.id, status: 'OUT_FOR_DELIVERY' } })) {
        if (o.issueStatus === 'PENDING') await act('асуудал засах (үлдсэн)', () => DR.resolveIssue(olead, o.id, { action: 'fix', note: 'Шалгасан' }));
        const v = (await db.order.findUniqueOrThrow({ where: { id: o.id } })).version;
        await act('эцсийн хүргэлт', () => DR.deliverOrder(d, o.id, { payment: o.prepaid ? undefined : 'CASH', note: o.prepaid ? 'Урьдчилж төлсөн' : undefined, version: v }));
      }
    });
    log('хүргэлт дууссан');
    await checkStock('3 хүргэлт');
    await checkDrivers('3 хүргэлт');

    // ───── 4. Буцаалт: агуулах жолооч бүрээс зэрэг ─────
    await pool(drivers, 3, async (d) => {
      const g = await G.goodsView(d.id);
      const lines = g.items.filter((i) => i.returnable > 0).map((i) => ({ variantId: i.variantId, qty: i.returnable }));
      if (lines.length) await act('буцаалт хүлээн авах', () => G.receiveReturn(wh, { driverId: d.id, lines, idemKey: key() }));
    });
    for (const d of drivers) {
      const g = await G.goodsView(d.id);
      const left = g.items.reduce((n, i) => n + i.balance, 0);
      if (left) bad('4 буцаалт', `${d.name}-ийн гарт ${left} ширхэг үлдсэн (хүргэлтэд захиалгагүй)`);
    }
    log('буцаалт');
    await checkStock('4 буцаалт');
    await checkDrivers('4 буцаалт');

    // ───── 5. Тооцоо нийлэх (жолооч илгээх → нягтлан баталгаажуулах), дараа нь өөрчлөлт түгжигдсэн ─────
    const rows = await C.computeDay(db, today);
    await pool(drivers, N_DRIVERS, async (d) => {
      const r = rows.find((x) => x.driverId === d.id);
      if (!r || !r.total) return;
      await act('тооцоо илгээх', () => S.submitSettlement(d, { date: today, cash: r.toReceive }));
    });
    const settles = await db.driverSettlement.findMany({ where: { date: U.dateOnly(today) } });
    await pool(settles, 3, async (s) => { await act('тооцоо батлах', () => S.approveSettlement(acc, s.id)); });
    const done = await db.driverSettlement.count({ where: { date: U.dateOnly(today), status: 'COMPLETED' } });
    eq('5 тооцоо', 'баталгаажсан тооцоо', done, rows.filter((r) => r.total).length);
    const lockedOrder = await db.order.findFirst({ where: { status: 'DELIVERED', handoverId: { not: null } } });
    if (lockedOrder) {
      const r = await act('түгжсэн өдөр төлөв солих', () => S.toggleOrderStatus(acc, lockedOrder.id, { target: 'CANCELLED', note: 'Түгжээ шалгах' }));
      if (r) bad('5 тооцоо', 'баталгаажсан өдрийн захиалгын төлөв солигдлоо (түгжээ ажиллаагүй)');
    }
    // Нягтлангийн самбар = computeDay
    const board = await S.accountingDay(acc, today);
    for (const r of rows) {
      const b = board.items.find((x) => x.driverId === r.driverId);
      if (b && (b.delivered !== r.delivered || b.toReceive !== r.toReceive)) bad('5 тооцоо', `${r.driverName}: самбар ${b.delivered}/${b.toReceive} ≠ тооцоо ${r.delivered}/${r.toReceive}`);
    }
    log(`тооцоо ${done}`);

    // ───── 6. Банк: урьдчилсан төлбөр = төлсөн; жагсаалт = статистик ─────
    const pre = await db.order.findMany({ where: { prepaid: true, status: { not: 'PENDING_PAYMENT' } }, select: { id: true, paidAmount: true, status: true } });
    for (const o of pre) {
      const [s] = await db.$queryRaw<{ s: number }[]>`SELECT COALESCE(sum(amount - "excessRefunded"),0)::int AS s FROM "BankTransaction" WHERE "orderId" = ${o.id} AND status IN ('MATCHED','EXCESS_AMOUNT','PARTIAL_PAYMENT') AND NOT refunded AND NOT "isDuplicate"`;
      if (o.status !== 'CANCELLED' && (s?.s ?? 0) < o.paidAmount) bad('6 банк', `захиалга #${o.id}: төлсөн ${o.paidAmount} > банкны ${s?.s}`);
    }
    const st = await B.bankStats(acc, {}).catch((e) => { bad('6 банк', `статистик: ${(e as Error).message}`); return null; }) as { total?: { count: number } } | null;
    const txCount = await db.bankTransaction.count();
    if (st?.total && st.total.count !== txCount) bad('6 банк', `статистик ${st.total.count} ≠ бүх гүйлгээ ${txCount}`);
    const pc = await B.paidCancelledList(sa);
    const [pcN] = await db.$queryRaw<{ n: number }[]>`SELECT count(DISTINCT o.id)::int AS n FROM "Order" o JOIN "BankTransaction" t ON t."orderId" = o.id AND t.status IN ('MATCHED','EXCESS_AMOUNT','PARTIAL_PAYMENT') AND NOT t.refunded AND NOT t."isDuplicate" WHERE o.status = 'CANCELLED' AND o."paidCancelReviewedAt" IS NULL`;
    eq('6 банк', '«Төлсөн ч цуцлагдсан» жагсаалт', pc.items.length, pcN?.n ?? 0);
    log(`банк: урьдчилсан ${pre.length}, төлсөн ч цуцлагдсан ${pc.items.length}`);

    // ───── 7. Нүүр, тайлан, барааны гарц, нийлүүлэгч ─────
    const [real] = await db.$queryRaw<{ total: number; delivered: number }[]>`
      SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'DELIVERED')::int AS delivered FROM "Order" WHERE "confirmedAt" >= ${U.ubDayStart(today)}`;
    const dash = await DSH.summary(sa, 'day', today);
    if (real && dash.kpi.delivered !== real.delivered) bad('7 нүүр', `нүүрийн хүргэсэн ${dash.kpi.delivered} ≠ бодит ${real.delivered}`);
    const acDay = await C.computeDay(db, today);
    if (real && dash.kpi.delivered !== acDay.reduce((n, r) => n + r.delivered, 0)) bad('7 нүүр', `нүүрийн хүргэсэн ${dash.kpi.delivered} ≠ нягтлангийн тооцооны ${acDay.reduce((n, r) => n + r.delivered, 0)}`);
    const rep = await RP.pageReport(sa, { from: today, to: today });
    const repRows = (rep as unknown as { rows: { created: number; delivered: number }[] }).rows;
    const createdAll = await db.order.count({ where: { createdAt: { gte: U.ubDayStart(today) } } });
    eq('7 тайлан', 'пэйжийн тайлан: үүссэн', repRows.reduce((n, r) => n + r.created, 0), createdAll);
    eq('7 тайлан', 'пэйжийн тайлан: хүргэсэн', repRows.reduce((n, r) => n + r.delivered, 0), await db.order.count({ where: { status: 'DELIVERED', deliveredAt: { gte: U.ubDayStart(today) } } }));
    OF.bustTable(); OF.bustOutflowCache();
    const tab = await OF.outflowTable(sa, {});
    const agg = await OF.unitsByDay(today, today);
    eq('7 барааны гарц', 'өнөөдрийн нийт ширхэг (хүснэгт ↔ тоолол)', tab.totals.today, agg.reduce((n, a) => n + a.qty, 0));
    await SP.syncAllShops();
    const sd = await SP.dayView(sa, shop, today);
    const shopVids = (await db.productVariant.findMany({ where: { productId: { in: shopProducts } }, select: { id: true } })).map((v) => v.id);
    const [sq2] = await db.$queryRaw<{ q: number }[]>`
      SELECT COALESCE(sum(l.qty - l."refusedQty"),0)::int AS q FROM "OrderLine" l JOIN "Order" o ON o.id = l."orderId" JOIN "Handover" h ON h.id = o."handoverId"
      WHERE o.status = 'DELIVERED' AND h.date = ${U.dateOnly(today)}::date AND l."variantId" = ANY(${shopVids}::int[])`;
    eq('7 нийлүүлэгч', 'нийлүүлэгчийн зарсан ширхэг ↔ хүргэсэн захиалга', sd.totals.qty, sq2?.q ?? 0);
    log('нүүр, тайлан, гарц, нийлүүлэгч');

    // ───── 8. Торгууль, зээл, цалин — бусад хуудас ачаалагдана, тоо таарна ─────
    const pen = await act('торгууль', () => PN.createPenalty(olead, { userId: ops[1]!.id, type: 'OPP_ERROR', customName: 'Хаяг буруу', amount: 5000, description: 'Сценари' }));
    if (pen) {
      const mine = await PN.myPenalties(ops[1]!, {}).catch((e) => { bad('8 торгууль', (e as Error).message); return null; }) as { items?: unknown[] } | null;
      if (mine && (mine.items?.length ?? 0) < 1) bad('8 торгууль', '«Миний торгууль»-д харагдаагүй');
    }
    const ln = await act('зээл хүсэх', () => LN.requestLoan(ops[2]!, { lines: [{ variantId: variants[0], qty: 1 }], note: 'Сценари', idemKey: key() })) as { id?: number; loan?: { id: number } } | null;
    const lnId = ln?.loan?.id ?? ln?.id;
    if (lnId) {
      await act('зээл олгох', () => LN.issueLoan(wh, lnId, { warehouseId: mainWh, lines: [{ variantId: variants[0], qty: 1 }] }));
      await act('зээл буцаах', () => LN.returnLoan(wh, lnId, { warehouseId: mainWh, lines: [{ variantId: variants[0], qty: 1 }], idemKey: key() }));
    }
    await act('цалингийн самбар', () => SAL.salaryBoard(sa, today.slice(0, 7)));
    await act('ахлах жолоочийн гүйцэтгэл', () => L.leadPerformance(dlead, { from: today, to: today }));
    await act('асуудлын жагсаалт', () => DR.listIssues(olead, {}));
    await act('нүүрийн анхааруулга', () => DSH.attention(sa));
    await act('буцаалтын самбар', () => G.returnsBoard(wh));
    await checkStock('8 эцсийн');
    await checkDrivers('8 эцсийн');
    log('дууслаа');

    // ───── Тайлан ─────
    const st2 = await db.order.groupBy({ by: ['status'], _count: true });
    console.log('ЗАХИАЛГЫН ТӨЛӨВ:', JSON.stringify(Object.fromEntries(st2.map((x) => [x.status, x._count]))));
    console.log('ХЭВИЙН ТАТГАЛЗАЛ (4xx):'); for (const [k, n] of Object.entries(expected)) console.log(`  ${k} × ${n} — ${sample[k]}`);
    console.log(problems.length ? `АСУУДАЛ ${problems.length}:\n${problems.join('\n')}` : 'АСУУДАЛ: 0 — бүх хуудас хоорондоо таарч байна');
    expect(problems).toEqual([]);
  });
});
