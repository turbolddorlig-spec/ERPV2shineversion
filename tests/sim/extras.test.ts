import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Role } from '@prisma/client';
import { AppError } from '@/lib/errors';
import type { UserActor } from '@/lib/services/users';
import { resetDb } from '../helpers/reset';
import { bankPay } from '../helpers/bankPay';
import { vi } from 'vitest';
import { installSimClock } from './clock';
import { readFileSync } from 'node:fs';

/**
 * #159 Нэмэлт сценари: цалингийн бүтэн урсгал (торгууль, зээл, өр, цоож, шилжүүлсэн), жолоочийн цалин, шөнийн автомат ажил, нийлүүлэгчид шилжүүлэх, хуучин ERP-ээс оруулах — хагас сарын заагийг давж. (#157-ийн)
 * #157 7 ХОНОГИЙН сценари (эзний хүсэлт): өдөрт 2,000 захиалга, 30 оператор, 80 жолооч. Цаг өдрөөр урагшилна (tests/sim/clock.ts).
 * (#156-ийн тусламж, тулгалтыг ашиглана)
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

const N_ORDERS = Number(process.env.SIM_ORDERS ?? 2000);
const N_DRIVERS = Number(process.env.SIM_DRIVERS ?? 80);
const N_OPS = Number(process.env.SIM_OPS ?? 30);
const N_DAYS = Number(process.env.SIM_DAYS ?? 7);

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



let LI: typeof import('@/lib/services/legacy-import');
let DB: typeof import('@/lib/services/accounting/debts');
beforeAll(async () => {
  process.env.DISABLE_JOBS = '1';
  db = (await import('@/lib/db')).db;
  installSimClock(db as never);
  P = await import('@/lib/services/products'); W = await import('@/lib/services/stock/warehouses'); D = await import('@/lib/services/stock/docs');
  V = await import('@/lib/services/stock/views'); O = await import('@/lib/services/orders/orders'); A = await import('@/lib/services/orders/admin');
  L = await import('@/lib/services/delivery/assign'); H = await import('@/lib/services/delivery/handover'); U = await import('@/lib/ubdate');
  DR = await import('@/lib/services/delivery/driver'); G = await import('@/lib/services/delivery/goods'); C = await import('@/lib/services/accounting/calc');
  S = await import('@/lib/services/accounting/settle'); B = await import('@/lib/services/accounting/bank'); SP = await import('@/lib/services/supplier');
  OF = await import('@/lib/services/outflow'); DSH = await import('@/lib/services/dashboard'); RP = await import('@/lib/services/orders/reports');
  SAL = await import('@/lib/services/salary'); PN = await import('@/lib/services/penalties'); LN = await import('@/lib/services/stock/loans');
  LI = await import('@/lib/services/legacy-import'); DB = await import('@/lib/services/accounting/debts');
  await resetDb(db as never);
});

const at = (day: string, hh: number, mm = 0) => vi.setSystemTime(new Date(`${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+08:00`));
const addD = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe('#159 нэмэлт сценари', () => {
  it('цалин, жолоочийн цалин, шөнийн ажил, нийлүүлэгч, хуучин ERP — хагас сарын заагаар', async () => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    const NO = Number(process.env.SIM_ORDERS ?? 300), ND = Number(process.env.SIM_DRIVERS ?? 10), NOP = 6, DAYS = 6;
    const day0 = '2026-10-12';
    today = day0; at(today, 8);
    const log = (s: string) => console.log(`[${today}] ${s}`);
    sa = await actor(['SUPER_ADMIN'], 'Эзэн'); adm = await actor(['ADMIN']); olead = await actor(['OPERATOR_LEAD']); dlead = await actor(['DRIVER_LEAD']);
    wh = await actor(['WAREHOUSE']); acc = await actor(['ACCOUNTING']); mkt = await actor(['MARKETING']);
    const pen = await actor(['PENALTY_OFFICER']);
    ops = []; for (let i = 0; i < NOP; i++) ops.push(await actor(['OPERATOR'], `Оператор ${i + 1}`));
    drivers = []; for (let i = 0; i < ND; i++) drivers.push(await actor(['DRIVER'], `Жолооч ${i + 1}`));
    for (const op of ops) await SAL.setConfig(sa, { staffKey: `u:${op.id}`, salaryType: 'ORDER_BASED', baseSalary: 0, bonusSalary: 0, oppRatePerOrder: 1500, dailyRate: 0 });
    for (const n of ['Гутал Шоп', 'Цүнх Шоп']) pages.push((await A.savePage(sa, { name: n })).id);
    mainWh = (await W.createWarehouse(sa, { name: 'Төв агуулах' })).id;
    const prodIds: number[] = [];
    for (let i = 0; i < 12; i++) { const p = await P.createProduct(sa, { code: `X${i}`, name: `Бараа ${i}`, price: 16000 + i * 2000, costPrice: 7000 }); prodIds.push(p.id); variants.push(p.variants[0]!.id); }
    for (const d of drivers) await H.setTrusted(acc, { driverId: d.id, trusted: true });
    shop = (await SP.saveShop(adm, { name: 'Нийлүүлэгч А', contactName: 'Бат', contactPhone: '99112233' })).id;
    shopProducts = prodIds.slice(0, 2);
    for (const pid of shopProducts) await SP.assignProduct(adm, { shopId: shop, productId: pid, fromDate: today, reason: 'Сценари' });
    await SP.saveDeduction(sa, { shopId: shop, productId: shopProducts[0], operatorCost: 1000, deliveryCost: 2000, marketingCost: 3000, otherCost: 0 });
    // Төлбөр хүлээх хугацаа 1 хоног — шөнийн автомат цуцлалт туршина
    await db.appSetting.upsert({ where: { key: 'paymentWaitDays' }, create: { key: 'paymentWaitDays', value: 1 }, update: { value: 1 } });
    await D.createReceipt(wh, { warehouseId: mainWh, lines: variants.map((v) => ({ variantId: v, qty: 400 })), idemKey: key() });

    const TEXT = readFileSync(new URL('../fixtures/legacy-sample.txt', import.meta.url), 'utf8');
    let ph = 0;
    const pendingIds: number[] = [];
    const shortDriver = new Set<string>();
    for (let di = 0; di <= DAYS; di++) {
      today = addD(day0, di);
      // ── 00:05 шөнийн автомат ажил (өчигдрийнх) ──
      at(today, 0, 5);
      const ac = await O.autoCancelExpired();
      const sh = await DB.closeDayShortages(new Date());
      await G.expireExtraRequests();
      if (di > 1) {
        // өчигдөр дутуу буцаасан жолооч → автомат өр
        const y = addD(today, -1);
        for (const id of shortDriver) {
          const n = await db.companyDebt.count({ where: { driverId: id, date: U.dateOnly(y) } }).catch(() => -1);
          if (n === 0) bad(`${today} шөнийн ажил`, `${drivers.find((d) => d.id === id)?.name}: дутуу барааны өр бичигдээгүй (${y})`);
        }
      }
      // Дутуу авчирсан жолооч өглөө 08:00-д үлдсэнээ авчирна (шөнө нь өр бичигдсэн — зөв)
      at(today, 8);
      for (const id of shortDriver) {
        const g = await G.goodsView(id); const ls = g.items.filter((i) => i.returnable > 0).map((i) => ({ variantId: i.variantId, qty: i.returnable }));
        if (ls.length) await act('өглөөний буцаалт', () => G.receiveReturn(wh, { driverId: id, lines: ls, idemKey: key() }));
      }
      shortDriver.clear();
      log(`шөнө: автомат цуцлалт ${ac}, дутуу өр ${JSON.stringify(sh)}`);
      // Хугацаа нь дууссан «Төлбөр хүлээж буй» үлдэх ёсгүй
      const stale = await db.order.count({ where: { status: 'PENDING_PAYMENT', paymentDeadline: { lt: new Date() } } });
      if (stale) bad(`${today} шөнийн ажил`, `хугацаа дууссан ${stale} «Төлбөр хүлээж буй» цуцлагдаагүй`);

      // ── Эхний өдөр 09:00: хуучин ERP-ээс оруулах (2 удаа дарна) ──
      if (di === 0) {
        at(today, 9);
      const rc0 = await db.stockReceipt.count();
      const l1 = await act('хуучин ERP оруулах', () => LI.legacyCommit(sa, { text: TEXT, driverName: 'Хуучин жолооч', driverPhone: '88112233' }));
      const rc1 = await db.stockReceipt.count(); const ord1 = await db.order.count();
      await act('хуучин ERP давтан', () => LI.legacyCommit(sa, { text: TEXT, driverName: 'Хуучин жолооч', driverPhone: '88112233' }));
      eq('хуучин ERP', 'давтан дарахад орлого/захиалга нэмэгдэхгүй', [await db.stockReceipt.count(), await db.order.count()], [rc1, ord1]);
      if (!l1) bad('хуучин ERP', 'оруулж чадсангүй');
      log(`хуучин ERP: ${ord1} захиалга, ${rc1 - rc0} орлого`);
      await checkStock('хуучин ERP');

      }
      // ── 14-нд операторт торгууль (1–15-ны хугацаанд) ──
      if (today === '2026-10-14') { at(today, 13); await PN.createPenalty(pen, { userId: ops[0]!.id, type: 'OPP_ERROR', customName: 'Хаяг буруу', amount: 5000 }); await PN.createPenalty(pen, { userId: ops[0]!.id, type: 'OPP_ERROR', customName: 'Утас буруу', amount: 3000 }); }
      if (di > 0) {
        at(today, 10);
        const ready = (await db.order.findMany({ where: { status: 'NEW', deliveryDate: { lte: U.dateOnly(today) } }, select: { id: true }, orderBy: { id: 'asc' } })).map((o) => o.id);
        const byD = new Map<string, number[]>(drivers.map((d) => [d.id, []]));
        ready.forEach((id, i) => byD.get(drivers[i % ND]!.id)!.push(id));
        await pool(drivers, 5, async (d) => {
          const ids = byD.get(d.id)!; if (!ids.length) return;
          await act('оноох', () => L.assignOrders(dlead, { ids, driverId: d.id }));
          const h = await act('падаан', () => H.createHandover(wh, { driverId: d.id, date: today, orderIds: ids })) as { id: number } | null;
          if (!h) return;
          await act('бэлтгэх', () => H.prepareHandover(wh, h.id));
          for (const it of (await H.handoverDetail(wh, h.id)).items) await act('тулгах', () => H.setCheck(wh, h.id, { variantId: it.variantId, checked: true }));
          await act('өгөх', () => H.confirmHandover(wh, h.id));
          await act('жолооч тулгах', () => H.setDriverCheck(d, h.id, { variantId: 'all', checked: true }));
          await act('хүлээн авах', () => H.receiveHandover(d, h.id));
        });
      }
      at(today, 12);
      await Promise.all([
        di < DAYS ? pool(Array.from({ length: NO }, (_, i) => i), NOP, async (i) => {
          const prepaid = rnd() < 0.15; const waitOnly = !prepaid && rnd() < 0.04;
          const r = await act('захиалга', () => O.createOrder(ops[i % NOP]!, { phone: String(81000000 + ++ph), province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: 3, addressDetail: 'Тест байр',
            pageId: pick(pages), lines: [{ variantId: pick(variants), qty: 1 + Math.floor(rnd() * 2) }], idemKey: key(), deliveryDate: addD(today, 1), ...(prepaid || waitOnly ? { prepaidWait: true } : {}) })) as { order: { id: number } } | null;
          if (!r) return;
          if (prepaid) await act('банк', () => bankPay(r.order.id)); else if (waitOnly) pendingIds.push(r.order.id);
        }) : Promise.resolve(),
        di > 0 ? pool(drivers, 10, async (d) => {
          for (const o of await db.order.findMany({ where: { driverId: d.id, status: 'OUT_FOR_DELIVERY' }, orderBy: { id: 'asc' } })) {
            const x = rnd(); const note = o.prepaid ? 'Урьдчилж төлсөн' : undefined; const pay = o.prepaid ? undefined : pick(['CASH', 'BANK']);
            if (x < 0.72) await act('хүргэх', () => DR.deliverOrder(d, o.id, { payment: pay, note, version: o.version }));
            else if (x < 0.85) await act('цуцлах', () => DR.driverCancel(d, o.id, { note: 'Утас авахгүй', version: o.version }));
            else await act('маргааш', () => DR.postponeOrder(d, o.id, { version: o.version }));
          }
        }) : Promise.resolve(),
      ]);
      if (di === 0) {
        // Хуучин жолоочийн «Маргааш» бараа агуулахад буцна (буцаахгүй бол шөнө нь дутуу барааны өр — зөв ажиллагаа)
        at(today, 21);
        const lg = await db.user.findUnique({ where: { phone: '88112233' } });
        if (lg) { const g = await G.goodsView(lg.id); const ls = g.items.filter((i) => i.returnable > 0).map((i) => ({ variantId: i.variantId, qty: i.returnable })); if (ls.length) await act('хуучин жолоочийн буцаалт', () => G.receiveReturn(wh, { driverId: lg.id, lines: ls, idemKey: key() })); }
        continue;
      }
      // ── 21:00 үлдсэнийг дуусгах, буцаалт (нэг жолооч 1 ширхэг дутуу), тооцоо ──
      at(today, 21);
      for (const d of drivers) for (const o of await db.order.findMany({ where: { driverId: d.id, status: 'OUT_FOR_DELIVERY' } })) await act('эцсийн хүргэлт', () => DR.deliverOrder(d, o.id, { payment: o.prepaid ? undefined : 'CASH', note: o.prepaid ? 'Урьдчилж төлсөн' : undefined, version: o.version }));
      const shortOne = drivers[di % ND]!;
      await pool(drivers, 5, async (d) => {
        const g = await G.goodsView(d.id);
        let lines = g.items.filter((i) => i.returnable > 0).map((i) => ({ variantId: i.variantId, qty: i.returnable }));
        if (d.id === shortOne.id && lines.length) { lines = lines.map((l, i) => (i === 0 ? { ...l, qty: l.qty - 1 } : l)).filter((l) => l.qty > 0); shortDriver.add(d.id); }
        if (lines.length) await act('буцаалт', () => G.receiveReturn(wh, { driverId: d.id, lines, idemKey: key() }));
      });
      at(today, 23);
      const rows = await C.computeDay(db, today);
      for (const d of drivers) {
        const r = rows.find((x) => x.driverId === d.id); if (!r?.total) continue;
        await act('тооцоо илгээх', () => S.submitSettlement(d, { date: today, cash: r.toReceive }));
        // Жолоочийн цалин: апп-ын «Орлого» = нягтлангийн тооцоо
        const inc = await S.driverIncome(d, today);
        eq(`${today} ${d.name}`, 'жолоочийн цалин (апп ↔ тооцоо)', inc.day.salary, r.salary);
      }
      // ── Нийлүүлэгчид шилжүүлэх (өдөр бүр) ──
      await SP.syncAllShops();
      const dv = await SP.dayView(adm, shop, today);
      const t = await act('нийлүүлэгчид шилжүүлэх', () => SP.transferDay(adm, { shopId: shop, date: today, version: dv.version })) as { payable: number } | null;
      if (t && dv.totals.net >= 0 && t.payable !== dv.payable) bad(`${today} нийлүүлэгч`, `шилжүүлсэн ${t.payable} ≠ харагдсан ${dv.payable}`);
      if (t && (await SP.dayView(adm, shop, today)).status !== 'TRANSFERRED') bad(`${today} нийлүүлэгч`, 'шилжүүлсэн төлөвт ороогүй');
      // Сүүлийн өдөр: нийлүүлэгчид шилжүүлсний ДАРАА (тооцоо батлахаас өмнө) хүргэсэн барааг СА цуцалбал → «Буцаалт» тохируулга
      if (di === DAYS) {
        const vids = (await db.productVariant.findMany({ where: { productId: { in: shopProducts } }, select: { id: true } })).map((v) => v.id);
        const hIds = (await db.handover.findMany({ where: { date: U.dateOnly(today) }, select: { id: true } })).map((h) => h.id);
        const o = await db.order.findFirst({ where: { status: 'DELIVERED', handoverId: { in: hIds }, lines: { some: { variantId: { in: vids } } } }, orderBy: { id: 'desc' } });
        if (o && t) {
          await act('СА цуцлах (нийлүүлэгч)', () => O.saCancelOrder(sa, o.id, { reason: 'OTHER', note: 'Буцааж өгсөн бараа', version: o.version }));
          await SP.syncAdjustments(shop);
          if (!(await db.supplierAdjustment.count({ where: { shopId: shop, kind: 'REFUND' } }))) bad('нийлүүлэгч', 'шилжүүлсний дараах цуцлалт «Буцаалт» болж бүртгэгдээгүй');
          // цуцалсан тул жолооч тооцоогоо дахин илгээнэ
          const rr = (await C.computeDay(db, today)).find((x) => x.driverId === o.driverId);
          const dd = drivers.find((x) => x.id === o.driverId);
          if (rr && dd) await act('тооцоо дахин илгээх', () => S.submitSettlement(dd, { date: today, cash: rr.toReceive }));
        }
      }
      for (const s of await db.driverSettlement.findMany({ where: { date: U.dateOnly(today), status: { not: 'COMPLETED' } } })) await act('батлах', () => S.approveSettlement(acc, s.id));
      await checkStock(`${today} эцэс`);
      await checkDrivers(`${today} эцэс`);
      log(`өдөр дууссан, асуудал ${problems.length}`);
    }
    // ───── Операторын цалин 1–15: торгууль, зээл, өр → хадгалах → цоожлох → шилжүүлсэн ─────
    today = '2026-10-19'; at(today, 10);
    const op1 = ops[0]!; const key1 = `u:${op1.id}`;
    const loan = await LN.requestLoan(op1, { lines: [{ variantId: variants[5], qty: 2 }], note: 'Өөртөө', idemKey: key() });
    await LN.issueLoan(wh, loan.loan.id, { warehouseId: mainWh, lines: [{ variantId: variants[5], qty: 2 }] });
    await SAL.addDebt(acc, { staffKey: key1, description: 'Утасны төлбөр', amount: 20000 });
    const prep = await SAL.prepareSalary(sa, key1, '2026-10', 1);
    const debt = prep.auto.debts[0]!;
    const [myN] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "Order" WHERE "operatorId" = ${op1.id}::uuid AND status = 'DELIVERED' AND "deliveredAt" >= ${U.ubDayStart('2026-10-01')} AND "deliveredAt" < ${U.ubDayStart('2026-10-16')}`;
    eq('цалин', 'захиалгын тоо (хүргэсэн өдрөөр 1–15)', prep.auto.orderCount, myN?.n ?? -1);
    const loanAmt = prep.auto.loans.reduce((n, l) => n + l.amount, 0);
    const rec = await SAL.saveSalary(sa, { staffKey: key1, ym: '2026-10', half: 1, penaltyDeducted: 8000, loanIds: prep.auto.loans.map((l) => l.id), debtPayments: [{ debtId: debt.id, amount: 10000 }] });
    eq('цалин', 'шилжүүлэх = захиалга × хөлс − торгууль − зээл − өр', rec.transferSalary, prep.auto.orderCount * 1500 - 8000 - loanAmt - 10000);
    const staffLoc = await db.stockLocation.findFirst({ where: { kind: 'STAFF', userId: op1.id } });
    const before = staffLoc ? (await db.stockBalance.aggregate({ where: { locationId: staffLoc.id }, _sum: { qty: true } }))._sum.qty ?? 0 : 0;
    await act('цоожлох', () => SAL.lockSalary(sa, rec.id));
    const pens = await db.penalty.findMany({ where: { userId: op1.id } });
    if (!pens.every((p) => p.deducted)) bad('цалин', 'цоожлоход торгууль «хасагдсан» болоогүй');
    const after = staffLoc ? (await db.stockBalance.aggregate({ where: { locationId: staffLoc.id }, _sum: { qty: true } }))._sum.qty ?? 0 : 0;
    eq('цалин', 'цоожлоход зээлсэн бараа ажилтны гараас хасагдсан (зарагдсанд тооцогдсон)', before - after, 2);
    eq('цалин', 'өрийн үлдэгдэл', (await db.staffDebt.findUniqueOrThrow({ where: { id: debt.id } })).remainingAmount, 10000);
    await act('шилжүүлсэн', () => SAL.setTransferred(sa, rec.id, true));
    const fin = await db.staffSalaryRecord.findUniqueOrThrow({ where: { id: rec.id } });
    eq('цалин', 'цоожтой + шилжүүлсэн', [fin.isLocked, fin.transferred], [true, true]);
    // Цоожилсны дараа 1–15-нд хүргэсэн захиалгыг цуцалбал — цоожтой цалин өөрчлөгдөхгүй
    const lateO = await db.order.findFirst({ where: { operatorId: op1.id, status: 'DELIVERED', deliveredAt: { lt: U.ubDayStart('2026-10-16') } } });
    if (lateO) await act('цоожны дараа цуцлах', () => O.saCancelOrder(sa, lateO.id, { reason: 'OTHER', note: 'Сүүлд буцаасан', version: lateO.version }));
    const fin2 = await db.staffSalaryRecord.findUniqueOrThrow({ where: { id: rec.id } });
    eq('цалин', 'цоожтой цалин хөдлөхгүй', [fin2.orderCount, fin2.transferSalary], [fin.orderCount, fin.transferSalary]);
    // 16–31 (хагас сарын заагаар): тоо = хүргэсэн өдрөөр, давхардалгүй
    let both = 0, all = 0;
    for (const op of ops) {
      const a = (await SAL.prepareSalary(sa, `u:${op.id}`, '2026-10', 1)).auto.orderCount; const b = (await SAL.prepareSalary(sa, `u:${op.id}`, '2026-10', 2)).auto.orderCount;
      both += a + b; all += await db.order.count({ where: { operatorId: op.id, status: 'DELIVERED' } });
    }
    eq('цалин', '1–15 + 16–31 = бүх хүргэсэн (давхардалгүй, алдагдалгүй)', both, all);
    await checkStock('эцэс');
    vi.useRealTimers();
    console.log('ХЭВИЙН ТАТГАЛЗАЛ (4xx):'); for (const [k, n] of Object.entries(expected)) console.log(`  ${k} × ${n} — ${sample[k]}`);
    console.log(problems.length ? `АСУУДАЛ ${problems.length}:\n${problems.slice(0, 100).join('\n')}` : 'АСУУДАЛ: 0');
    expect(problems).toEqual([]);
  }, 3_600_000);
});
