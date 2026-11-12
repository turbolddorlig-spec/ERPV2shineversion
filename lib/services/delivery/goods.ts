import type { DeliveryPayment, DriverDocKind, Prisma } from '@prisma/client';
import { syncShortageDebts } from '../accounting/debts';
import { computeDay } from '../accounting/calc';
import { db } from '../../db';
import { badRequest, conflict, forbidden } from '../../errors';
import { writeAudit } from '../../audit';
import { canDrive, canReceiveReturns, canView } from '../../permissions';
import { dateOnly, ubDay, ubDayStart, isYmd } from '../../ubdate';
import { applyMoves, stockCache } from '../stock/core';
import { variantInfo } from '../stock/info';
import { availableFor, inTx, lockVariants, type UserActor } from '../orders/core';
import { bustCounts } from '../orders/queries';
import { addDays, driverLocationId, lockDelivery, primaryWarehouse, type Tx } from './core';
import { driverGoods, PAYMENT_LABEL } from './driver';

/**
 * Модуль 5 — жолоочийн гарт байгаа бараа:
 *   «Буцаалт хүлээн авах» (агуулах): жолоочийн буцаах бараа → үндсэн агуулах (DRIVER_RETURN). Дутуу нь жолоочид үлдэнэ.
 *   «Нэмэлт бараа» (жолооч, хуучин шиг): агуулах → жолооч (EXTRA_OUT); зарсан → гарна (EXTRA_SALE), үнэ СИСТЕМИЙН үнээр.
 *   «Жолоочийн хяналт»: өдөр, жолооч бүрээр — оноосон, хүргэлтэд, хүргэсэн, цуцалсан, хойшилсон, гарт байгаа, буцаах, мөнгө.
 * Бүх үйлдэл хүргэлтийн түгжээ дор (buцаах тоо = үлдэгдэл − хүргэлтэд явж буй, зэрэг үйлдэлд зөрөхгүй), давхар дарахад нэг удаа (idemKey).
 */
const DOC_LABEL: Record<DriverDocKind, string> = { RETURN: 'Буцаалт хүлээн авсан', EXTRA_TAKE: 'Нэмэлт бараа авсан', EXTRA_SALE: 'Нэмэлт бараа зарсан' };
const EXTRA_STATUS: Record<string, string> = { REQUESTED: 'Нэмэлт бараа — падаанд хүлээгдэж байна', GIVEN: 'Нэмэлт бараа — падаанаар авсан', CANCELLED: 'Нэмэлт бараа — цуцалсан', DONE: 'Нэмэлт бараа авсан' };

function cleanUuid(v: unknown, label = 'Жолооч'): string {
  const s = String(v ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(s)) throw badRequest(`${label} буруу`);
  return s;
}
function cleanIdem(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!/^[\w-]{8,80}$/.test(s)) throw badRequest('Хуудсаа дахин ачаална уу (түлхүүр буруу)', 'bad_idem');
  return s;
}
function cleanLines(v: unknown, max = 200): { variantId: number; qty: number }[] {
  if (!Array.isArray(v)) throw badRequest('Бараа сонгоно уу');
  const m = new Map<number, number>();
  for (const x of v as { variantId?: unknown; qty?: unknown }[]) {
    const id = Number(x?.variantId); const q = Number(x?.qty);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('Бараа буруу');
    if (!Number.isInteger(q) || q < 0 || q > 10000) throw badRequest('Тоо буруу');
    if (q > 0) m.set(id, (m.get(id) ?? 0) + q);
  }
  if (m.size > max) throw badRequest(`Нэг дор ${max} хүртэл бараа`);
  return [...m].map(([variantId, qty]) => ({ variantId, qty }));
}
async function labelsOf(ids: number[]) {
  const info = await variantInfo(ids);
  return new Map([...info].map(([id, i]) => [id, `${i.name}${i.label ? ` · ${i.label}` : ''}`]));
}
async function driverUser(id: string) {
  const u = await db.user.findUnique({ where: { id }, select: { id: true, name: true, roles: true } });
  if (!u || !u.roles.includes('DRIVER')) throw badRequest('Жолооч олдсонгүй');
  return u;
}
async function existingDoc(idemKey: string) {
  return db.driverDoc.findUnique({ where: { idemKey }, include: { lines: true } });
}

/** Жолоочийн бараа (апп, агуулах, хяналт): бараа бүрийн гарт, хүргэлтэд, буцаах */
export async function goodsView(driverId: string) {
  const g = await driverGoods(db, driverId);
  const ids = [...g.balance.keys()];
  const info = await variantInfo(ids);
  const items = ids.map((v) => {
    const i = info.get(v);
    return { variantId: v, code: i?.code ?? '', name: i?.name ?? `#${v}`, label: i?.label ?? '', thumb: i?.thumb ?? null, shelfCode: i?.shelfCode ?? null,
      balance: g.balance.get(v) ?? 0, held: Math.min(g.held.get(v) ?? 0, g.balance.get(v) ?? 0), returnable: g.returnable.get(v) ?? 0 };
  }).sort((a, b) => (a.shelfCode ?? '~').localeCompare(b.shelfCode ?? '~') || a.code.localeCompare(b.code));
  return { items, totals: { balance: items.reduce((n, x) => n + x.balance, 0), returnable: items.reduce((n, x) => n + x.returnable, 0) } };
}

/** Жолооч: миний бараа + сүүлийн баримтууд */
export async function myGoods(actor: UserActor) {
  if (!canDrive(actor.roles)) throw forbidden();
  const [v, docs] = await Promise.all([goodsView(actor.id), recentDocs(actor.id)]);
  return { ...v, docs };
}

async function recentDocs(driverId: string, take = 20) {
  const docs = await db.driverDoc.findMany({ where: { driverId }, orderBy: { id: 'desc' }, take, include: { lines: true } });
  const info = await variantInfo([...new Set(docs.flatMap((d) => d.lines.map((l) => l.variantId)))]);
  return docs.map((d) => ({
    id: d.id, kind: d.kind, kindLabel: d.kind === 'EXTRA_TAKE' ? EXTRA_STATUS[d.status] ?? DOC_LABEL[d.kind] : DOC_LABEL[d.kind], status: d.status, date: d.date ? d.date.toISOString().slice(0, 10) : null, at: d.createdAt, byName: d.byName, note: d.note, total: d.total,
    payment: d.payment, paymentLabel: d.payment ? PAYMENT_LABEL[d.payment] : null,
    lines: d.lines.map((l) => ({ variantId: l.variantId, name: info.get(l.variantId)?.name ?? `#${l.variantId}`, label: info.get(l.variantId)?.label ?? '', qty: l.qty, expected: l.expected, unitPrice: l.unitPrice })),
  }));
}

// ───────────────────────── Буцаалт хүлээн авах (агуулах) ─────────────────────────

/** Буцаах бараатай жолоочид (агуулахын самбар) */
export async function returnsBoard(actor: UserActor) {
  if (!canView(actor.roles, 'warehouse') && !canView(actor.roles, 'handover')) throw forbidden();
  const rows = await db.$queryRaw<{ driverId: string; name: string; balance: number; held: number }[]>`
    WITH bal AS (
      SELECT l."userId", sum(b.qty)::int AS balance FROM "StockLocation" l JOIN "StockBalance" b ON b."locationId" = l.id AND b.qty > 0
      WHERE l.kind = 'DRIVER' GROUP BY l."userId"),
    held AS (
      SELECT o."driverId", sum(ol.qty)::int AS held FROM "Order" o JOIN "OrderLine" ol ON ol."orderId" = o.id
      WHERE o.status = 'OUT_FOR_DELIVERY' AND o."driverId" IN (SELECT "userId" FROM bal) GROUP BY 1)
    SELECT bal."userId" AS "driverId", u.name, bal.balance, COALESCE(held.held, 0)::int AS held
    FROM bal JOIN "User" u ON u.id = bal."userId" LEFT JOIN held ON held."driverId" = bal."userId" ORDER BY u.name`;
  const last = await db.$queryRaw<{ driverId: string; at: Date }[]>`SELECT "driverId", max("createdAt") AS at FROM "DriverDoc" WHERE kind = 'RETURN' GROUP BY 1`;
  const lm = new Map(last.map((x) => [x.driverId, x.at]));
  return {
    canReceive: canReceiveReturns(actor.roles),
    items: rows.map((r) => ({ driverId: r.driverId, name: r.name, balance: r.balance, held: Math.min(r.held, r.balance), returnable: Math.max(0, r.balance - r.held), lastReturnAt: lm.get(r.driverId) ?? null }))
      .filter((r) => r.balance > 0)
      // Буцаах бараатай жолооч эхэнд (их → бага), дараа нь нэрээр
      .sort((a, b) => b.returnable - a.returnable || a.name.localeCompare(b.name)),
  };
}

/** Нэг жолоочийн буцаах бараа + яагаад (сүүлийн 7 хоногийн цуцалсан, хойшилсон, болиулсан захиалга) */
export async function driverReturnable(actor: UserActor, driverIdIn: unknown) {
  if (!canView(actor.roles, 'warehouse') && !canView(actor.roles, 'handover') && !canView(actor.roles, 'driver-control')) throw forbidden();
  const driverId = cleanUuid(driverIdIn);
  const u = await driverUser(driverId);
  const since = ubDayStart(ubDay(new Date(), -7));
  // 3 тусдаа индекстэй асуулга (OR нэг асуулгад 1 сая захиалгыг бүхэлд нь уншдаг байсан)
  const sel = { id: true, number: true, status: true, cancelledAt: true, postponedAt: true, deliveredAt: true } as const;
  const [goods, cancelled, postponed, partial, docs] = await Promise.all([
    goodsView(driverId),
    db.order.findMany({ where: { driverId, cancelledAt: { gte: since }, status: 'CANCELLED', outForDeliveryAt: { not: null } }, orderBy: { cancelledAt: 'desc' }, take: 40, select: sel }),
    db.order.findMany({ where: { postponedByDriverId: driverId, postponedAt: { gte: since }, outForDeliveryAt: { not: null } }, orderBy: { postponedAt: 'desc' }, take: 40, select: sel }),
    db.order.findMany({ where: { driverId, deliveredAt: { gte: since }, status: 'DELIVERED', originalTotal: { not: null }, lines: { some: { refusedQty: { gt: 0 } } } }, orderBy: { deliveredAt: 'desc' }, take: 40, select: sel }),
    recentDocs(driverId, 10),
  ]);
  const sources = [...cancelled, ...postponed, ...partial].sort((a, b) => b.id - a.id);
  return {
    driver: { id: u.id, name: u.name }, canReceive: canReceiveReturns(actor.roles), ...goods, docs,
    sources: sources.map((o) => ({ id: o.id, number: o.number, why: o.status === 'DELIVERED' ? 'Болиулсан бараа' : o.status === 'CANCELLED' && o.cancelledAt ? 'Цуцалсан' : 'Маргааш', at: o.cancelledAt ?? o.deliveredAt ?? o.postponedAt })),
  };
}

/** «Хүлээн авсан»: тоолсон тоогоор жолоочоос үндсэн агуулахад. Дутуу нь жолоочид үлдэнэ (дараа буцаана / өр — Модуль 6) */
export async function receiveReturn(actor: UserActor, input: { driverId?: unknown; lines?: unknown; note?: unknown; idemKey?: unknown }) {
  if (!canReceiveReturns(actor.roles)) throw forbidden('Буцаалтыг агуулахын ажилтан, админ хүлээн авна');
  const driverId = cleanUuid(input.driverId);
  const idemKey = cleanIdem(input.idemKey);
  const lines = cleanLines(input.lines);
  if (!lines.length) throw badRequest('Хүлээн авсан барааны тоог оруулна уу');
  const dup = await existingDoc(idemKey);
  if (dup) return { doc: dup, duplicate: true };
  const u = await driverUser(driverId);
  const note = String(input.note ?? '').trim().slice(0, 500) || null;
  const labels = await labelsOf(lines.map((l) => l.variantId));
  const doc = await inTx(async (tx) => {
    await lockDelivery(tx);
    const again = await tx.driverDoc.findUnique({ where: { idemKey } });
    if (again) return again;
    const g = await driverGoods(tx, driverId);
    for (const l of lines) {
      const have = g.returnable.get(l.variantId) ?? 0;
      if (l.qty > have) throw conflict(`«${labels.get(l.variantId)}» жолоочид буцаах ${have} байна (оруулсан ${l.qty})`, 'too_many');
    }
    const { locationId: whLoc } = await primaryWarehouse(tx);
    const fromId = await driverLocationId(tx, u);
    const d = await tx.driverDoc.create({
      data: { kind: 'RETURN', driverId, driverName: u.name, byId: actor.id, byName: actor.name, note, idemKey,
        lines: { create: lines.map((l) => ({ variantId: l.variantId, qty: l.qty, expected: g.returnable.get(l.variantId) ?? 0 })) } },
    });
    await applyMoves(tx, actor, { type: 'driver_doc', id: d.id }, lines.map((l) => ({ type: 'DRIVER_RETURN' as const, variantId: l.variantId, qty: l.qty, fromId, toId: whLoc, note: `${u.name}-с буцаалт` })), labels);
    const short = [...g.returnable].map(([v, have]) => ({ variantId: v, name: labels.get(v) ?? null, short: have - (lines.find((l) => l.variantId === v)?.qty ?? 0) })).filter((x) => x.short > 0 && x.name);
    // Модуль 6 (#82 6): буцаасан барааны автомат өр буурна / хаагдана
    await syncShortageDebts(tx, driverId);
    await writeAudit(actor, 'driver.return', 'DriverDoc', String(d.id), { driver: u.name, pieces: lines.reduce((n, l) => n + l.qty, 0), ...(note ? { note } : {}), ...(short.length ? { short } : {}) } as Prisma.InputJsonValue, tx, ['stock', 'delivery']);
    return d;
  });
  stockCache.today = null;
  return { doc, duplicate: false };
}

// ───────────────────────── Нэмэлт бараа (жолооч, хуучин шиг) ─────────────────────────

/**
 * Нэмэлт бараа ХҮСЭХ (#80): бараа шууд хөдлөхгүй — хүсэлт үүсэж, захиалах боломжтойгоос нөөцлөгдөнө (давхар амлахгүй).
 * Тэр өдрийн падаанд «Нэмэлт бараа» хэсэгт тусдаа орно (падаан хараахан үүсээгүй бол үүсэх үед). Агуулах Check хийж
 * «Барааг бүрэн өгсөн» → жолооч чагтлаад «Барааг бүрэн хүлээн авсан» дармагц л агуулахаас жолоочид шилжинэ (EXTRA_OUT).
 * Тэр өдрийн падаан өгөгдсөн бол дараагийн өдрийн падаанд.
 */
export async function extraTake(actor: UserActor, input: { lines?: unknown; note?: unknown; idemKey?: unknown }) {
  if (!canDrive(actor.roles)) throw forbidden();
  const idemKey = cleanIdem(input.idemKey);
  const lines = cleanLines(input.lines, 50);
  if (!lines.length) throw badRequest('Бараа, тоогоо оруулна уу');
  const dup = await existingDoc(idemKey);
  if (dup) return { doc: dup, duplicate: true };
  const note = String(input.note ?? '').trim().slice(0, 500) || null;
  const labels = await labelsOf(lines.map((l) => l.variantId));
  const doc = await inTx(async (tx) => {
    await lockDelivery(tx);
    const again = await tx.driverDoc.findUnique({ where: { idemKey } });
    if (again) return again;
    // Захиалга үүсгэх / засахтай ижил барааны түгжээ (#124-8) — сүүлийн ширхэгийг давхар амлахгүй
    await lockVariants(tx, [...new Set(lines.map((l) => l.variantId))]);
    const av = await availableFor(tx, lines.map((l) => l.variantId));
    for (const l of lines) {
      const a = av.get(l.variantId) ?? 0;
      if (l.qty > a) throw conflict(`«${labels.get(l.variantId)}» захиалах боломжтой ${Math.max(0, a)} (захиалгын нөөцөд хүрэхгүй)`, 'insufficient_stock');
    }
    // Аль өдрийн падаанд орох: өнөөдрийнх өгөгдөөгүй бол өнөөдөр, өгөгдсөн бол дараагийн өдөр
    let date = ubDay(); let handoverId: number | null = null;
    for (let i = 0; i < 30; i++) {
      const h = await tx.handover.findUnique({ where: { driverId_date: { driverId: actor.id, date: dateOnly(date) } }, select: { id: true, status: true } });
      if (h && (h.status === 'HANDED_OVER' || h.status === 'RECEIVED')) { date = addDays(date, 1); continue; }
      handoverId = h?.id ?? null;
      break;
    }
    const d = await tx.driverDoc.create({
      data: { kind: 'EXTRA_TAKE', status: 'REQUESTED', date: dateOnly(date), handoverId, driverId: actor.id, driverName: actor.name, byId: actor.id, byName: actor.name, note, idemKey,
        lines: { create: lines.map((l) => ({ variantId: l.variantId, qty: l.qty })) } },
    });
    await tx.stockReservation.createMany({ data: lines.map((l) => ({ ref: `extra:${d.id}`, variantId: l.variantId, qty: l.qty })) });
    if (handoverId) {
      // Бэлдэж буй падаанд нэмэгдлээ — тэр барааны «нэмэлт» Check дахин хийгдэнэ
      await tx.handoverCheck.deleteMany({ where: { handoverId, kind: 'EXTRA', variantId: { in: lines.map((l) => l.variantId) } } });
      await tx.handover.update({ where: { id: handoverId }, data: { version: { increment: 1 } } });
    }
    await writeAudit(actor, 'driver.extra_request', 'DriverDoc', String(d.id), { date, pieces: lines.reduce((n, l) => n + l.qty, 0), lines: lines.map((l) => ({ name: labels.get(l.variantId), qty: l.qty })) } as Prisma.InputJsonValue, tx, ['delivery']);
    return d;
  });
  stockCache.today = null; bustCounts();
  return { doc, duplicate: false };
}

/** Нэмэлт барааны хүсэлтээ цуцлах — падаанаар өгөгдөхөөс өмнө л */
export async function extraCancel(actor: UserActor, docIdIn: unknown) {
  if (!canDrive(actor.roles)) throw forbidden();
  const id = Number(docIdIn);
  if (!Number.isInteger(id) || id <= 0) throw badRequest('Хүсэлт олдсонгүй');
  await inTx(async (tx) => {
    await lockDelivery(tx);
    const d = await tx.driverDoc.findUnique({ where: { id }, include: { lines: true } });
    if (!d || d.driverId !== actor.id || d.kind !== 'EXTRA_TAKE') throw badRequest('Хүсэлт олдсонгүй');
    if (d.status === 'CANCELLED') return;
    if (d.status !== 'REQUESTED') throw conflict('Падаанаар аль хэдийн авсан — үлдсэнийг буцаалтаар өгнө', 'already_given');
    if (d.handoverId) {
      const h = await tx.handover.findUnique({ where: { id: d.handoverId }, select: { status: true } });
      if (h && (h.status === 'HANDED_OVER' || h.status === 'RECEIVED')) throw conflict('Агуулах падаанаар өгсөн — агуулахад хэлнэ үү', 'handed_over');
      await tx.handoverCheck.deleteMany({ where: { handoverId: d.handoverId, kind: 'EXTRA', variantId: { in: d.lines.map((l) => l.variantId) } } });
      await tx.handover.update({ where: { id: d.handoverId }, data: { version: { increment: 1 } } });
    }
    await tx.stockReservation.deleteMany({ where: { ref: `extra:${id}` } });
    await tx.driverDoc.update({ where: { id }, data: { status: 'CANCELLED', handoverId: null } });
    await writeAudit(actor, 'driver.extra_cancelled', 'DriverDoc', String(id), {}, tx, ['delivery']);
  });
  stockCache.today = null; bustCounts();
  return { ok: true };
}

/** Нэмэлт бараа зарсан: жолоочийн буцаах бараанаас, СИСТЕМИЙН үнээр (жолооч үнэ бичихгүй). Мөнгө — Модуль 6 */
export async function extraSale(actor: UserActor, input: { lines?: unknown; payment?: unknown; note?: unknown; idemKey?: unknown }) {
  if (!canDrive(actor.roles)) throw forbidden();
  const idemKey = cleanIdem(input.idemKey);
  const lines = cleanLines(input.lines, 50);
  if (!lines.length) throw badRequest('Зарсан бараа, тоогоо оруулна уу');
  const payment = String(input.payment ?? '') as DeliveryPayment;
  if (!['CASH', 'BANK', 'UNPAID'].includes(payment)) throw badRequest('Төлбөрөө сонгоно уу: Бэлэн / Данс / Төлөөгүй', 'payment_required');
  const dup = await existingDoc(idemKey);
  if (dup) return { doc: dup, duplicate: true };
  const note = String(input.note ?? '').trim().slice(0, 500) || null;
  const labels = await labelsOf(lines.map((l) => l.variantId));
  const prices = new Map((await db.productVariant.findMany({ where: { id: { in: lines.map((l) => l.variantId) } }, select: { id: true, priceOverride: true, product: { select: { price: true } } } }))
    .map((v) => [v.id, v.priceOverride ?? v.product.price]));
  const doc = await inTx(async (tx) => {
    await lockDelivery(tx);
    const again = await tx.driverDoc.findUnique({ where: { idemKey } });
    if (again) return again;
    const g = await driverGoods(tx, actor.id);
    for (const l of lines) {
      const have = g.returnable.get(l.variantId) ?? 0;
      if (l.qty > have) throw conflict(`«${labels.get(l.variantId)}» танд ${have} байна (хүргэлтийн захиалгын барааг зарахгүй)`, 'too_many');
    }
    const total = lines.reduce((n, l) => n + (prices.get(l.variantId) ?? 0) * l.qty, 0);
    const fromId = await driverLocationId(tx, actor);
    const d = await tx.driverDoc.create({
      data: { kind: 'EXTRA_SALE', driverId: actor.id, driverName: actor.name, byId: actor.id, byName: actor.name, note, idemKey, payment, total,
        lines: { create: lines.map((l) => ({ variantId: l.variantId, qty: l.qty, unitPrice: prices.get(l.variantId) ?? 0 })) } },
    });
    await applyMoves(tx, actor, { type: 'driver_doc', id: d.id }, lines.map((l) => ({ type: 'EXTRA_SALE' as const, variantId: l.variantId, qty: l.qty, fromId, toId: null, note: 'Нэмэлт бараа зарсан' })), labels);
    await syncShortageDebts(tx, actor.id);
    await writeAudit(actor, 'driver.extra_sale', 'DriverDoc', String(d.id), { total, payment, lines: lines.map((l) => ({ name: labels.get(l.variantId), qty: l.qty, price: prices.get(l.variantId) })) } as Prisma.InputJsonValue, tx, ['stock', 'delivery', 'money']);
    return d;
  });
  stockCache.today = null;
  return { doc, duplicate: false };
}

// ───────────────────────── Жолоочийн хяналт ─────────────────────────

/** Өдөр, жолооч бүрээр (зөвхөн харах). Хүргэсэн/цуцалсан/мөнгө — падааны өдрөөр (B1, #83, аудит Б2) */
export async function driverControl(actor: UserActor, dateIn?: string) {
  if (!canView(actor.roles, 'driver-control')) throw forbidden();
  const date = dateIn && isYmd(dateIn) ? dateIn : ubDay();
  const t0 = ubDayStart(date); const t1 = ubDayStart(addDays(date, 1)); const d = dateOnly(date);
  const [drivers, plan, done, post, extra, goods, last] = await Promise.all([
    db.user.findMany({ where: { roles: { has: 'DRIVER' }, isActive: true }, orderBy: { name: 'asc' }, select: { id: true, name: true, phone: true } }),
    db.$queryRaw<{ id: string; assigned: number; out: number }[]>`
      SELECT "driverId" AS id, count(*) FILTER (WHERE status = 'ASSIGNED' AND "deliveryDate" = ${d}::date)::int AS assigned,
        count(*) FILTER (WHERE status = 'OUT_FOR_DELIVERY')::int AS out
      FROM "Order" WHERE "driverId" IS NOT NULL AND (status = 'OUT_FOR_DELIVERY' OR (status = 'ASSIGNED' AND "deliveryDate" = ${d}::date)) GROUP BY 1`,
    // Аудит Б2 (B1, #83): хүргэсэн / цуцалсан / мөнгө — ПАДААНЫ ӨДРӨӨР, нягтлангийн «Тооцоо»-той нэг томьёо (computeDay)
    computeDay(db, date),
    db.$queryRaw<{ id: string; postponed: number }[]>`
      SELECT "postponedByDriverId" AS id, count(*)::int AS postponed FROM "Order" WHERE "postponedByDriverId" IS NOT NULL AND "postponedAt" >= ${t0} AND "postponedAt" < ${t1} GROUP BY 1`,
    db.$queryRaw<{ id: string; extraSales: number }[]>`
      SELECT "driverId" AS id, COALESCE(sum(total), 0)::int AS "extraSales" FROM "DriverDoc" WHERE kind = 'EXTRA_SALE' AND "createdAt" >= ${t0} AND "createdAt" < ${t1} GROUP BY 1`,
    db.$queryRaw<{ id: string; balance: number; held: number }[]>`
      WITH bal AS (
        SELECT l."userId", sum(b.qty)::int AS balance FROM "StockLocation" l JOIN "StockBalance" b ON b."locationId" = l.id AND b.qty > 0
        WHERE l.kind = 'DRIVER' GROUP BY l."userId"),
      held AS (
        SELECT o."driverId", sum(ol.qty)::int AS held FROM "Order" o JOIN "OrderLine" ol ON ol."orderId" = o.id
        WHERE o.status = 'OUT_FOR_DELIVERY' AND o."driverId" IN (SELECT "userId" FROM bal) GROUP BY 1)
      SELECT bal."userId" AS id, bal.balance, COALESCE(held.held, 0)::int AS held FROM bal LEFT JOIN held ON held."driverId" = bal."userId"`,
    db.$queryRaw<{ id: string; at: Date }[]>`SELECT "driverId" AS id, max("createdAt") AS at FROM "DriverDoc" WHERE kind = 'RETURN' GROUP BY 1`,
  ]);
  const by = <T extends { id: string }>(rows: T[]) => new Map(rows.map((r) => [r.id, r]));
  const P = by(plan); const C = by(post); const E = by(extra); const G = by(goods); const L = by(last);
  const D = new Map(done.map((x) => [x.driverId, x]));
  const items = drivers.map((u) => {
    const g = G.get(u.id); const dd = D.get(u.id);
    return {
      id: u.id, name: u.name, phone: u.phone,
      assigned: P.get(u.id)?.assigned ?? 0, out: P.get(u.id)?.out ?? 0,
      delivered: dd?.delivered ?? 0, partial: dd?.partialCount ?? 0, cancelled: (dd?.cancelled ?? 0) + (dd?.excluded ?? 0), postponed: C.get(u.id)?.postponed ?? 0,
      goods: g?.balance ?? 0, returnable: Math.max(0, (g?.balance ?? 0) - (g?.held ?? 0)), lastReturnAt: L.get(u.id)?.at ?? null,
      cash: dd?.cash ?? 0, bank: dd?.bank ?? 0, unpaid: dd?.unpaid ?? 0, prepaid: dd?.prepaidAmount ?? 0, deliveredSum: dd?.deliveredAmount ?? 0, extraSales: E.get(u.id)?.extraSales ?? 0,
    };
  }).filter((x) => x.assigned + x.out + x.delivered + x.cancelled + x.postponed + x.goods + x.extraSales > 0);
  const sum = (k: keyof (typeof items)[number]) => items.reduce((n, x) => n + (Number(x[k]) || 0), 0);
  return {
    date, items,
    totals: { assigned: sum('assigned'), out: sum('out'), delivered: sum('delivered'), cancelled: sum('cancelled'), postponed: sum('postponed'), goods: sum('goods'), returnable: sum('returnable'), cash: sum('cash'), bank: sum('bank'), unpaid: sum('unpaid'), extraSales: sum('extraSales') },
  };
}

export { DOC_LABEL };
export type GoodsTx = Tx;

/**
 * Тэр өдрийн падаанд ороогүй нэмэлт барааны хүсэлт 00:00-д автоматаар цуцлагдана (#124-9): нөөц суллагдана,
 * жолоочид «цуцлагдсан — дахин хүснэ үү» гэж харагдана. Арын ажил минут тутам дуудна (давхар ажиллахгүй).
 */
export async function expireExtraRequests(): Promise<number> {
  const today = ubDay();
  const docs = await db.driverDoc.findMany({ where: { kind: 'EXTRA_TAKE', status: 'REQUESTED', date: { lt: dateOnly(today) } }, select: { id: true }, take: 200 });
  let n = 0;
  for (const { id } of docs) {
    const done = await inTx(async (tx) => {
      await lockDelivery(tx);
      const d = await tx.driverDoc.findUnique({ where: { id }, include: { lines: true } });
      if (!d || d.status !== 'REQUESTED' || !d.date || ymdOfDate(d.date) >= today) return false;
      if (d.handoverId) {
        const h = await tx.handover.findUnique({ where: { id: d.handoverId }, select: { status: true } });
        if (h && (h.status === 'HANDED_OVER' || h.status === 'RECEIVED')) return false;
        await tx.handoverCheck.deleteMany({ where: { handoverId: d.handoverId, kind: 'EXTRA', variantId: { in: d.lines.map((l) => l.variantId) } } });
        await tx.handover.update({ where: { id: d.handoverId }, data: { version: { increment: 1 } } });
      }
      await tx.stockReservation.deleteMany({ where: { ref: `extra:${id}` } });
      await tx.driverDoc.update({ where: { id }, data: { status: 'CANCELLED', handoverId: null, note: [d.note, 'Өдөр дууссан — падаанд ороогүй тул автоматаар цуцлагдсан, дахин хүснэ үү'].filter(Boolean).join(' · ').slice(0, 500) } });
      await writeAudit({ id: null, name: 'СИСТЕМ' }, 'driver.extra_expired', 'DriverDoc', String(id), { driver: d.driverName, date: ymdOfDate(d.date!), pieces: d.lines.reduce((s, l) => s + l.qty, 0) }, tx, ['delivery']);
      return true;
    });
    if (done) n++;
  }
  if (n) { stockCache.today = null; bustCounts(); }
  return n;
}
const ymdOfDate = (d: Date) => d.toISOString().slice(0, 10);
