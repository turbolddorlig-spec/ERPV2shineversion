import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Role } from '@prisma/client';
import { AppError } from '@/lib/errors';
import type { UserActor } from '@/lib/services/users';
import { resetDb } from '../helpers/reset';
import { bankPay } from '../helpers/bankPay';
import { vi } from 'vitest';
import { installSimClock } from './clock';

/**
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
  await resetDb(db as never);
});

const at = (day: string, hh: number) => vi.setSystemTime(new Date(`${day}T${String(hh).padStart(2, '0')}:00:00+08:00`));

describe('#157 7 хоног: өдөрт 2,000 захиалга, 30 оператор, 80 жолооч', () => {
  it('7 хоногийн сценари + өдөр бүрийн ба 7 хоногийн тулгалт', async () => {
    const t0 = Date.now();
    const real = () => ((performance.now()) / 1000).toFixed(0);
    const log = (s: string) => console.log(`[${real()}s ${today}] ${s}`);
    void t0;
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    const realToday = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    const day0 = new Date(Date.parse(`${realToday}T00:00:00Z`) - (N_DAYS + 1) * 86_400_000).toISOString().slice(0, 10);
    const addD = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    today = day0; at(today, 8);
    // ───── Бэлтгэл ─────
    sa = await actor(['SUPER_ADMIN'], 'Эзэн'); adm = await actor(['ADMIN']); olead = await actor(['OPERATOR_LEAD']); dlead = await actor(['DRIVER_LEAD']);
    wh = await actor(['WAREHOUSE']); acc = await actor(['ACCOUNTING']); mkt = await actor(['MARKETING']);
    const olead2 = await actor(['OPERATOR_LEAD']); const wh2 = await actor(['WAREHOUSE']);
    ops = []; for (let i = 0; i < N_OPS; i++) ops.push(await actor(['OPERATOR'], `Оператор ${i + 1}`));
    drivers = []; for (let i = 0; i < N_DRIVERS; i++) drivers.push(await actor(['DRIVER'], `Жолооч ${i + 1}`));
    for (const n of ['Гутал Шоп', 'Цүнх Шоп', 'Хувцас Шоп', 'Гэр ахуй', 'Гоо сайхан']) pages.push((await A.savePage(sa, { name: n })).id);
    mainWh = (await W.createWarehouse(sa, { name: 'Төв агуулах' })).id;
    const prodIds: number[] = [];
    for (let i = 0; i < 30; i++) {
      const p = await P.createProduct(sa, { code: `W${i}`, name: `Бараа ${i}`, price: 15000 + (i % 10) * 3000, costPrice: 6000 + (i % 10) * 1000, ...(i % 4 === 0 ? { colors: ['Хар', 'Цагаан'] } : {}) });
      prodIds.push(p.id); variants.push(...p.variants.map((v) => v.id));
    }
    for (const d of drivers) await H.setTrusted(acc, { driverId: d.id, trusted: true });
    shop = (await SP.saveShop(adm, { name: 'Нийлүүлэгч А', contactName: 'Бат', contactPhone: '99112233' })).id;
    shopProducts = prodIds.slice(0, 3);
    for (const pid of shopProducts) await SP.assignProduct(adm, { shopId: shop, productId: pid, fromDate: today, reason: 'Сценари' });
    await SP.saveDeduction(sa, { shopId: shop, productId: shopProducts[0], operatorCost: 1000, deliveryCost: 2000, marketingCost: 3000, otherCost: 0 });
    for (const pid of prodIds.slice(0, 8)) await act('бүүст', () => OF.saveBoost(mkt, { productId: pid, zones: 1, dollar: 5 }));
    log('бэлтгэл');

    const perDayUnits = Math.ceil((N_ORDERS * 3.2) / variants.length);
    const snap = new Map<string, string>();
    let ph = 0;
    const createdByDay = new Map<string, number>();

    for (let di = 0; di <= N_DAYS; di++) {
      today = addD(day0, di);
      // ── 08:00 Агуулахад орлого (дутууг нөхнө) ──
      at(today, 8);
      const main = (await db.stockLocation.findUniqueOrThrow({ where: { warehouseId: mainWh } })).id;
      // Боломжтой = агуулахад − нөөцлөгдсөн (маргаашийн захиалга) — өдрийн хэрэгцээний 2 дахинд хүртэл нөхнө
      const bals = new Map((await db.stockBalance.findMany({ where: { locationId: main } })).map((b) => [b.variantId, b.qty]));
      const resv = new Map((await db.stockReservation.groupBy({ by: ['variantId'], _sum: { qty: true } })).map((r) => [r.variantId, r._sum.qty ?? 0]));
      const top = variants.map((v) => ({ variantId: v, qty: Math.max(0, perDayUnits * 2 + (resv.get(v) ?? 0) - (bals.get(v) ?? 0)) })).filter((l) => l.qty > 0);
      if (top.length) await act('орлого', () => D.createReceipt(wh, { warehouseId: mainWh, lines: top, idemKey: key() }));

      // ── 10:00 Өчигдрийн захиалга + «Маргааш» → оноох, падаан ──
      if (di > 0) {
        at(today, 10);
        const ready = (await db.order.findMany({ where: { status: 'NEW', deliveryDate: { lte: U.dateOnly(today) } }, select: { id: true }, orderBy: { id: 'asc' } })).map((o) => o.id);
        const byDriver = new Map<string, number[]>(drivers.map((d) => [d.id, []]));
        ready.forEach((id, i) => byDriver.get(drivers[(i + di) % N_DRIVERS]!.id)!.push(id));
        await pool(drivers, 10, async (d) => { const ids = byDriver.get(d.id)!; for (let i = 0; i < ids.length; i += 100) await act('оноох', () => L.assignOrders(dlead, { ids: ids.slice(i, i + 100), driverId: d.id })); });
        await pool(drivers, 10, async (d) => {
          const ids = (await db.order.findMany({ where: { driverId: d.id, status: 'ASSIGNED', deliveryDate: { lte: U.dateOnly(today) } }, select: { id: true } })).map((o) => o.id);
          if (!ids.length) return;
          const who = d.id.charCodeAt(0) % 2 ? wh : wh2;
          const h = await act('падаан үүсгэх', () => H.createHandover(who, { driverId: d.id, date: today, orderIds: ids })) as { id: number } | null;
          if (!h) return;
          await act('падаан бэлтгэх', () => H.prepareHandover(who, h.id));
          const det = await H.handoverDetail(who, h.id);
          for (const it of det.items) await act('тулгах', () => H.setCheck(who, h.id, { variantId: it.variantId, checked: true }));
          await act('падаан өгөх', () => H.confirmHandover(who, h.id));
          await act('жолооч тулгах', () => H.setDriverCheck(d, h.id, { variantId: 'all', checked: true }));
          await act('жолооч хүлээн авах', () => H.receiveHandover(d, h.id));
        });
        log(`падаан: ${ready.length} захиалга`);
      }

      // ── 11:00–18:00 Операторууд маргаашийн захиалга авна (зэрэг) ‖ жолооч нар хүргэнэ (зэрэг) ──
      at(today, 12);
      const issues: number[] = [];
      const ordering = di < N_DAYS ? pool(Array.from({ length: N_ORDERS }, (_, i) => i), N_OPS, async (i) => {
        const op = ops[i % N_OPS]!;
        const lines = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => ({ variantId: pick(variants), qty: 1 + Math.floor(rnd() * 2) }));
        const uniq = [...new Map(lines.map((l) => [l.variantId, l])).values()];
        const prepaid = rnd() < 0.12;
        const r = await act('захиалга үүсгэх', () => O.createOrder(op, {
          phone: String(80000000 + ++ph), province: 'Улаанбаатар', district: pick(['Баянзүрх', 'Сүхбаатар', 'Хан-Уул', 'Чингэлтэй']), khoroo: 1 + Math.floor(rnd() * 20),
          addressDetail: i % 50 === 0 ? 'Маш урт хаяг '.repeat(20) : 'Тест байр', pageId: pick(pages), lines: uniq, idemKey: key(), deliveryDate: addD(today, 1), ...(prepaid ? { prepaidWait: true } : {}),
        })) as { order: { id: number; version: number } } | null;
        if (!r) return;
        createdByDay.set(today, (createdByDay.get(today) ?? 0) + 1);
        if (prepaid) await act('банкаар төлөх', () => bankPay(r.order.id));
        else if (rnd() < 0.03) await act('оператор цуцлах', () => O.cancelOrder(olead, r.order.id, { reason: 'CUSTOMER_CANCELLED', note: 'Захиалагч болих гэсэн', version: r.order.version }));
      }) : Promise.resolve();
      const delivering = di > 0 ? pool(drivers, 20, async (d) => {
        const os = await db.order.findMany({ where: { driverId: d.id, status: 'OUT_FOR_DELIVERY' }, include: { lines: true }, orderBy: { id: 'asc' } });
        for (const o of os) {
          const x = rnd();
          const pay = o.prepaid ? undefined : pick(['CASH', 'CASH', 'BANK']);
          const note = o.prepaid ? 'Урьдчилж төлсөн' : undefined;
          if (x < 0.62) await act('хүргэх', () => DR.deliverOrder(d, o.id, { payment: pay, note, version: o.version }));
          else if (x < 0.69 && o.lines.some((l) => l.qty > 1 || o.lines.length > 1)) {
            const taken = Object.fromEntries(o.lines.map((l, i) => [l.id, i === 0 ? Math.max(1, l.qty - 1) : 0]));
            await act('хэсэгчлэн хүргэх', () => DR.deliverOrder(d, o.id, { payment: o.prepaid ? undefined : 'CASH', taken, note: 'Хэсэгчлэн авсан', version: o.version }));
          } else if (x < 0.79) await act('жолооч цуцлах', () => DR.driverCancel(d, o.id, { note: 'Захиалагч утсаа авахгүй', version: o.version }));
          else if (x < 0.88) await act('маргааш', () => DR.postponeOrder(d, o.id, { version: o.version }));
          else if (x < 0.93) { if (await act('асуудал', () => DR.reportIssue(d, o.id, { type: pick(['WRONG_NUMBER', 'UNCLEAR_ADDRESS']), note: 'Утас холбогдохгүй' }))) issues.push(o.id); }
          else await act('хүргэх', () => DR.deliverOrder(d, o.id, { payment: pay, note, version: o.version }));
          if (rnd() < 0.03) await act('давхар хүргэх', () => DR.deliverOrder(d, o.id, { payment: 'CASH', version: o.version }));
        }
      }) : Promise.resolve();
      await Promise.all([ordering, delivering]);
      log(`захиалга ${createdByDay.get(today) ?? 0}, асуудал ${issues.length}`);

      if (di > 0) {
        // ── 19:00 Асуудал (2 ахлах зэрэг), СА / нягтлан цуцлах, үлдсэнийг дуусгах ──
        at(today, 19);
        await pool(issues, 8, async (id) => {
          await Promise.all([act('асуудал засах', () => DR.resolveIssue(olead, id, { action: 'fix', note: 'Зөв утас олдсон' })), act('асуудал цуцлах', () => DR.resolveIssue(olead2, id, { action: 'cancel', note: 'Захиалагч татгалзсан', fault: pick(['OPERATOR', 'DRIVER']) }))]);
        });
        const hIds = (await db.handover.findMany({ where: { date: U.dateOnly(today) }, select: { id: true } })).map((h) => h.id);
        const dlv = await db.order.findMany({ where: { status: 'DELIVERED', handoverId: { in: hIds } }, take: 4, orderBy: { id: 'desc' } });
        for (const o of dlv.slice(0, 2)) await act('СА цуцлах', () => O.saCancelOrder(sa, o.id, { reason: 'OTHER', note: 'Үйлчлүүлэгч буцааж өгсөн', version: o.version }));
        for (const o of dlv.slice(2, 4)) await act('нягтлан төлөв солих', () => S.toggleOrderStatus(acc, o.id, { target: 'CANCELLED', note: 'Үйлчлүүлэгч буцаасан' }));
        at(today, 21);
        await pool(drivers, 20, async (d) => {
          for (const o of await db.order.findMany({ where: { driverId: d.id, status: 'OUT_FOR_DELIVERY' } })) {
            if (o.issueStatus === 'PENDING') await act('асуудал засах (үлдсэн)', () => DR.resolveIssue(olead, o.id, { action: 'fix', note: 'Шалгасан' }));
            const v = (await db.order.findUniqueOrThrow({ where: { id: o.id } })).version;
            await act('эцсийн хүргэлт', () => DR.deliverOrder(d, o.id, { payment: o.prepaid ? undefined : 'CASH', note: o.prepaid ? 'Урьдчилж төлсөн' : undefined, version: v }));
          }
        });
        await checkStock(`${today} хүргэлт`);
        await checkDrivers(`${today} хүргэлт`);
        // ── 22:00 Буцаалт ──
        at(today, 22);
        await pool(drivers, 6, async (d) => {
          const g = await G.goodsView(d.id);
          const lines = g.items.filter((i) => i.returnable > 0).map((i) => ({ variantId: i.variantId, qty: i.returnable }));
          if (lines.length) await act('буцаалт хүлээн авах', () => G.receiveReturn(d.id.charCodeAt(1) % 2 ? wh : wh2, { driverId: d.id, lines, idemKey: key() }));
        });
        for (const d of drivers) { const g = await G.goodsView(d.id); const left = g.items.reduce((n, i) => n + i.balance, 0); if (left) bad(`${today} буцаалт`, `${d.name}-ийн гарт ${left} үлдсэн`); }
        // ── 23:00 Тооцоо нийлэх ──
        at(today, 23);
        const rows = await C.computeDay(db, today);
        await pool(drivers, 20, async (d) => { const r = rows.find((x) => x.driverId === d.id); if (r?.total) await act('тооцоо илгээх', () => S.submitSettlement(d, { date: today, cash: r.toReceive })); });
        const settles = await db.driverSettlement.findMany({ where: { date: U.dateOnly(today), status: { not: 'COMPLETED' } } });
        await pool(settles, 6, async (s) => { await act('тооцоо батлах', () => S.approveSettlement(acc, s.id)); });
        const done = await db.driverSettlement.count({ where: { date: U.dateOnly(today), status: 'COMPLETED' } });
        eq(`${today} тооцоо`, 'баталгаажсан тооцоо', done, rows.filter((r) => r.total).length);
        const left = await db.order.count({ where: { status: { in: ['ASSIGNED', 'OUT_FOR_DELIVERY'] }, deliveryDate: { lte: U.dateOnly(today) } } });
        if (left) bad(`${today} өдрийн эцэс`, `дуусаагүй ${left} захиалга үлдсэн`);
        await checkStock(`${today} өдрийн эцэс`);
        await checkDrivers(`${today} өдрийн эцэс`);
        // Тухайн өдрийн тооцоог хадгалж, 7 хоногийн эцэст өөрчлөгдөөгүй эсэхийг шалгана (түгжээ)
        snap.set(today, JSON.stringify((await C.computeDay(db, today)).map((r) => [r.driverId, r.delivered, r.cancelled, r.postponed, r.cash, r.bank, r.prepaidAmount, r.salary, r.toReceive]).sort()));
        await SP.syncAllShops();
        log(`өдөр дууссан: тооцоо ${done}, асуудал нийт ${problems.length}`);
      }
    }

    // ───── 7 хоногийн тулгалт ─────
    today = addD(day0, N_DAYS);
    at(today, 23);
    for (const [d, s] of snap) {
      const now = JSON.stringify((await C.computeDay(db, d)).map((r) => [r.driverId, r.delivered, r.cancelled, r.postponed, r.cash, r.bank, r.prepaidAmount, r.salary, r.toReceive]).sort());
      if (now !== s) bad(`7 хоног ${d}`, 'түгжсэн өдрийн тооцоо дараа нь өөрчлөгдсөн');
    }
    const from = addD(day0, 0); const to = today;
    // Тайлан: үүссэн захиалга = операторуудын үүсгэсэн
    const rep = await RP.pageReport(sa, { from, to }) as unknown as { rows: { created: number; delivered: number; cancelled: number }[] };
    const createdAll = [...createdByDay.values()].reduce((a, b) => a + b, 0);
    eq('7 хоног тайлан', 'үүссэн захиалга', rep.rows.reduce((n, r) => n + r.created, 0), createdAll);
    eq('7 хоног тайлан', 'хүргэсэн', rep.rows.reduce((n, r) => n + r.delivered, 0), await db.order.count({ where: { status: 'DELIVERED' } }));
    // Нүүр (7 хоног): хүргэсэн = нягтлангийн өдрүүдийн нийлбэр биш (баталгаажсан өдрөөр) — бодит тоололтой
    const dash = await DSH.summary(sa, 'week', to);
    const [realW] = await db.$queryRaw<{ d: number }[]>`SELECT count(*)::int AS d FROM "Order" WHERE status = 'DELIVERED' AND "confirmedAt" >= ${U.ubDayStart(addD(to, -6))} AND "confirmedAt" < ${U.ubDayStart(addD(to, 1))}`;
    eq('7 хоног нүүр', 'хүргэсэн (сүүлийн 7 хоног, баталгаажсан өдрөөр)', dash.kpi.delivered, realW?.d ?? -1);
    // Барааны гарц: 7 хоногийн нийт ширхэг
    OF.bustTable(); OF.bustOutflowCache();
    const tab = await OF.outflowTable(sa, {});
    const all7 = await OF.unitsByDay(addD(to, -6), to);
    const tabWeek = (await Promise.all(Array.from({ length: Math.ceil(tab.total / 50) }, (_, i) => OF.outflowTable(sa, { page: i + 1 })))).flatMap((t) => t.rows).reduce((n, r) => n + r.weekTotal, 0);
    eq('7 хоног гарц', '7 хоногийн нийт ширхэг (хүснэгт ↔ тоолол)', tabWeek, all7.reduce((n, a) => n + a.qty, 0));
    // Нийлүүлэгч: 7 хоногийн нийлбэр = өдөр бүрийн нийлбэр = хүргэсэн захиалга
    const rs = await SP.rangeSummary(sa, shop, from, to);
    let byDays = 0; for (let i = 1; i <= N_DAYS; i++) byDays += (await SP.dayView(sa, shop, addD(day0, i))).totals.qty;
    const shopVids = (await db.productVariant.findMany({ where: { productId: { in: shopProducts } }, select: { id: true } })).map((v) => v.id);
    const [sq] = await db.$queryRaw<{ q: number }[]>`
      SELECT COALESCE(sum(l.qty - l."refusedQty"),0)::int AS q FROM "OrderLine" l JOIN "Order" o ON o.id = l."orderId" JOIN "Handover" h ON h.id = o."handoverId"
      WHERE o.status = 'DELIVERED' AND l."variantId" = ANY(${shopVids}::int[])`;
    eq('7 хоног нийлүүлэгч', 'хугацааны нийлбэр ↔ өдрүүдийн нийлбэр ↔ хүргэсэн', [rs.totals.qty, byDays], [sq?.q ?? -1, sq?.q ?? -1]);
    // Цалин, гүйцэтгэл, бусад хуудас ачаалагдана
    await act('цалингийн самбар', () => SAL.salaryBoard(sa, to.slice(0, 7)));
    await act('ахлах жолоочийн гүйцэтгэл (7 хоног)', () => L.leadPerformance(dlead, { from, to }));
    await act('асуудлын жагсаалт', () => DR.listIssues(olead, {}));
    await act('банкны статистик', () => B.bankStats(acc, {}));
    await act('нүүрийн анхааруулга', () => DSH.attention(sa));
    await checkStock('7 хоног эцэс');
    vi.useRealTimers();

    const st2 = await db.order.groupBy({ by: ['status'], _count: true });
    console.log('ЗАХИАЛГЫН ТӨЛӨВ:', JSON.stringify(Object.fromEntries(st2.map((x) => [x.status, x._count]))));
    console.log('ӨДӨР БҮРИЙН ҮҮССЭН:', JSON.stringify(Object.fromEntries(createdByDay)));
    console.log('ХЭВИЙН ТАТГАЛЗАЛ (4xx):'); for (const [k, n] of Object.entries(expected)) console.log(`  ${k} × ${n} — ${sample[k]}`);
    console.log(problems.length ? `АСУУДАЛ ${problems.length}:\n${problems.slice(0, 200).join('\n')}` : 'АСУУДАЛ: 0 — 7 хоногийн турш бүх хуудас хоорондоо таарч байна');
    expect(problems).toEqual([]);
  }, 7_200_000);
});
