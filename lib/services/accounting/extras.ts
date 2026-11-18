import { Prisma } from '@prisma/client';
import { db } from '../../db';
import { badRequest, forbidden } from '../../errors';
import { writeAudit } from '../../audit';
import { canAccount } from '../../permissions';
import { isYmd, ubDay, ubDayStart } from '../../ubdate';
import { inTx, type UserActor } from '../orders/core';
import { addDays, driverLocationId, lockDrivers } from '../delivery/core';
import { applyMoves, stockCache } from '../stock/core';
import { goodsView } from '../delivery/goods';
import { computeDay } from './calc';

type Tx = Prisma.TransactionClient;

/**
 * #175 Нэмэлт барааны ТУСДАА тооцоо (эзний шийдвэр) — жолоочийн өдрийн үндсэн тооцоонд огт нийлэхгүй.
 *   Жолооч «зарсан» гэж бүртгэнэ (REPORTED) → нягтлангийн самбарт жолооч бүрээр шууд харагдана (жолооч хүсэлт илгээх шаардлагагүй).
 *   Хөлс = ширхэг × тэр өдрийн 1 хүргэлтийн хөлс (жолоочийн горим, гүйцэтгэлээр — Онцгой / Орон нутаг ч мөн).
 *   Нягтлан «Нэмэлтийн мөнгө авсан» → бараа жолоочоос журналаар гарна (EXTRA_SALE), баримт DONE, хөлс хадгалагдана.
 * Зараагүй, буцаагаагүй нэмэлт барааны өр — бүтэн үнээр (өрийн бүртгэлд, debts.ts adjustExtraDebts).
 */
const assertAccount = (a: UserActor) => { if (!canAccount(a.roles)) throw forbidden('Энэ үйлдлийг нягтлан, админ хийнэ'); };

/** Жолоочийн тухайн өдрийн 1 хүргэлтийн хөлс (нягтлангийн тооцоотой нэг томьёо) — өдөр бүрээр нэг удаа тооцно */
function rateCache(tx: Tx | typeof db) {
  const days = new Map<string, Promise<Map<string, number>>>();
  return async (ymd: string, driverId: string): Promise<number> => {
    let p = days.get(ymd);
    if (!p) { p = computeDay(tx, ymd).then((rows) => new Map(rows.map((r) => [r.driverId, r.rate]))); days.set(ymd, p); }
    const m = await p;
    if (!m.has(driverId)) m.set(driverId, (await computeDay(tx, ymd, driverId))[0]?.rate ?? 0);
    return m.get(driverId)!;
  };
}

interface SaleRow { id: number; driverId: string; driverName: string; createdAt: Date; total: number; payment: string | null; status: string; fee: number | null; settledAt: Date | null; settledByName: string | null; pieces: number }

async function salesOf(tx: Tx | typeof db, where: Prisma.Sql) {
  return tx.$queryRaw<SaleRow[]>`
    SELECT d.id, d."driverId", d."driverName", d."createdAt", d.total, d.payment::text AS payment, d.status::text AS status, d.fee, d."settledAt", d."settledByName",
      COALESCE((SELECT sum(l.qty) FROM "DriverDocLine" l WHERE l."docId" = d.id), 0)::int AS pieces
    FROM "DriverDoc" d WHERE d.kind = 'EXTRA_SALE' AND ${where} ORDER BY d."createdAt" ASC LIMIT 2000`;
}

/**
 * Нягтлангийн самбарын «Нэмэлт бараа» хэсэг (тухайн өдөр): жолооч бүрээр — авсан, зарсан (тушаагаагүй), буцаах, хөлс, авах дүн,
 * мөн тэр өдөр тооцоо хийсэн. Үргэлж шууд (live) тооцно — өдрийн тооцооны хуулбарт ордоггүй.
 */
export async function extrasDay(dateIn?: string) {
  const date = dateIn && isYmd(dateIn) ? dateIn : ubDay();
  const t0 = ubDayStart(date); const t1 = ubDayStart(addDays(date, 1));
  const [taken, open, settled] = await Promise.all([
    db.$queryRaw<{ driverId: string; driverName: string; pieces: number }[]>`
      SELECT d."driverId", max(d."driverName") AS "driverName", COALESCE(sum(l.qty), 0)::int AS pieces FROM "DriverDoc" d JOIN "DriverDocLine" l ON l."docId" = d.id
      WHERE d.kind = 'EXTRA_TAKE' AND d.status = 'GIVEN' AND d.date = ${date}::date GROUP BY 1`,
    // Тушаагаагүй «зарсан» — тухайн өдөр болон түүнээс өмнөх (хоцорсон ч алга болохгүй)
    salesOf(db, Prisma.sql`d.status = 'REPORTED' AND d."createdAt" < ${t1}`),
    salesOf(db, Prisma.sql`d.status = 'DONE' AND d."settledAt" >= ${t0} AND d."settledAt" < ${t1}`),
  ]);
  const rate = rateCache(db);
  const by = new Map<string, {
    driverId: string; driverName: string; taken: number;
    open: { docs: number; pieces: number; amount: number; fee: number; receive: number; rate: number | null; lines: { id: number; at: Date; pieces: number; amount: number; payment: string | null; fee: number }[] };
    settled: { pieces: number; amount: number; fee: number; receive: number; byName: string | null };
    toReturn: number;
  }>();
  const get = (id: string, name: string) => {
    let x = by.get(id);
    if (!x) { x = { driverId: id, driverName: name, taken: 0, open: { docs: 0, pieces: 0, amount: 0, fee: 0, receive: 0, rate: null, lines: [] }, settled: { pieces: 0, amount: 0, fee: 0, receive: 0, byName: null }, toReturn: 0 }; by.set(id, x); }
    return x;
  };
  for (const t of taken) get(t.driverId, t.driverName).taken += t.pieces;
  for (const s of open) {
    const x = get(s.driverId, s.driverName);
    const r = await rate(ubDay(s.createdAt), s.driverId);
    const fee = s.pieces * r;
    x.open.docs++; x.open.pieces += s.pieces; x.open.amount += s.total; x.open.fee += fee; x.open.receive += s.total - fee;
    x.open.rate = x.open.rate === null || x.open.rate === r ? r : -1; // -1 = өөр өөр өдрийн хөлс
    x.open.lines.push({ id: s.id, at: s.createdAt, pieces: s.pieces, amount: s.total, payment: s.payment, fee });
  }
  for (const s of settled) {
    const x = get(s.driverId, s.driverName);
    x.settled.pieces += s.pieces; x.settled.amount += s.total; x.settled.fee += s.fee ?? 0; x.settled.receive += s.total - (s.fee ?? 0); x.settled.byName = s.settledByName;
  }
  // Буцаах (зараагүй) нэмэлт бараа — жолоочийн гарт одоо байгаа
  await Promise.all([...by.values()].map(async (x) => { x.toReturn = (await goodsView(x.driverId)).totals.extra; }));
  const items = [...by.values()].map((x) => ({ ...x, open: { ...x.open, rate: x.open.rate === -1 ? null : x.open.rate } }))
    .sort((a, b) => b.open.receive - a.open.receive || a.driverName.localeCompare(b.driverName, 'mn'));
  const sum = (f: (x: (typeof items)[number]) => number) => items.reduce((n, x) => n + f(x), 0);
  return {
    date, items,
    totals: {
      taken: sum((x) => x.taken), openPieces: sum((x) => x.open.pieces), openAmount: sum((x) => x.open.amount), openFee: sum((x) => x.open.fee), openReceive: sum((x) => x.open.receive),
      settledAmount: sum((x) => x.settled.amount), settledFee: sum((x) => x.settled.fee), settledReceive: sum((x) => x.settled.receive), toReturn: sum((x) => x.toReturn),
    },
  };
}

export async function extrasBoard(actor: UserActor, dateIn?: string) {
  assertAccount(actor);
  return extrasDay(dateIn);
}

/**
 * «Нэмэлтийн мөнгө авсан»: жолоочийн тушаагаагүй бүх «зарсан» (тухайн өдөр хүртэл) — хөлсийг хасаж нягтлан мөнгийг авсан.
 * Бараа жолоочоос журналаар гарна (EXTRA_SALE, B2), баримт DONE + хөлс. Давхар дарахад нэг л удаа (жолоочийн түгжээ + төлөв).
 */
export async function settleExtras(actor: UserActor, input: { driverId?: unknown; date?: unknown }) {
  assertAccount(actor);
  const driverId = String(input.driverId ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(driverId)) throw badRequest('Жолооч буруу');
  const date = typeof input.date === 'string' && isYmd(input.date) ? input.date : ubDay();
  const t1 = ubDayStart(addDays(date, 1));
  const r = await inTx(async (tx) => {
    await lockDrivers(tx, [driverId]);
    const docs = await tx.driverDoc.findMany({ where: { driverId, kind: 'EXTRA_SALE', status: 'REPORTED', createdAt: { lt: t1 } }, include: { lines: true }, orderBy: { id: 'asc' }, take: 500 });
    if (!docs.length) return { docs: 0, pieces: 0, amount: 0, fee: 0, receive: 0, duplicate: true };
    const rate = rateCache(tx);
    const fromId = await driverLocationId(tx, { id: driverId, name: docs[0]!.driverName });
    const now = new Date();
    let pieces = 0, amount = 0, fee = 0;
    for (const d of docs) {
      const q = d.lines.reduce((n, l) => n + l.qty, 0);
      const f = q * (await rate(ubDay(d.createdAt), driverId));
      await applyMoves(tx, actor, { type: 'driver_doc', id: d.id }, d.lines.map((l) => ({ type: 'EXTRA_SALE' as const, variantId: l.variantId, qty: l.qty, fromId, toId: null, note: `Нэмэлт бараа зарсан — нягтлан тооцоо хийсэн (${d.driverName})` })));
      await tx.driverDoc.update({ where: { id: d.id }, data: { status: 'DONE', fee: f, settledAt: now, settledByName: actor.name } });
      pieces += q; amount += d.total; fee += f;
    }
    await writeAudit(actor, 'extras.settled', 'DriverDoc', docs.map((d) => d.id).join(',').slice(0, 190), { driver: docs[0]!.driverName, date, docs: docs.length, pieces, amount, fee, receive: amount - fee }, tx, ['money', 'stock', 'delivery']);
    return { docs: docs.length, pieces, amount, fee, receive: amount - fee, duplicate: false };
  });
  stockCache.today = null;
  return r;
}
