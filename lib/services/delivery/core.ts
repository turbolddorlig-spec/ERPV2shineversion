import type { Prisma } from '@prisma/client';
import { db } from '../../db';
import { badRequest } from '../../errors';
import { dateOnly, ubDay, ymdOf } from '../../ubdate';

export type Tx = Prisma.TransactionClient;

/**
 * Модуль 4-ийн түгжээний дараалал (deadlock-гүй, #48-ыг өргөтгөнө):
 *   1) хүргэлтийн нийтлэг түгжээ (хуваарилах, падаан, хуваарилсан захиалгыг цуцлах) →
 *   2) падааны мөр (FOR UPDATE) → 3) захиалгууд (id өсөхөөр, FOR UPDATE) → 4) бараа.
 * Эдгээр үйлдэл цөөн (ахлах жолооч, агуулах) бөгөөд богино тул нэг түгжээ хангалттай, зэрэг дарахад давхар бичигдэхгүй.
 */
export async function lockDelivery(tx: Tx) {
  // Аудит #141: түгжээг 8 сек-ээс удаан хүлээхгүй — олон хүн зэрэг дарахад холболт (pool) хүлээлтэд эзлэгдэж, нягтлан зэрэг
  // бусад хуудас гацахаас сэргийлнэ. Хэтэрвэл «Систем түр завгүй — дахин дарна уу» (errorResponse, 409 busy).
  await tx.$executeRaw`SET LOCAL lock_timeout = '8s'`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(3::int4, 0::int4)`;
}

export async function lockOrders(tx: Tx, ids: number[]) {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  if (!sorted.length) return [];
  return tx.$queryRaw<{ id: number }[]>`SELECT id FROM "Order" WHERE id = ANY(${sorted}::int[]) ORDER BY id FOR UPDATE`;
}

export async function lockHandover(tx: Tx, id: number) {
  const r = await tx.$queryRaw<{ id: number }[]>`SELECT id FROM "Handover" WHERE id = ${id} FOR UPDATE`;
  return r.length > 0;
}

export const HANDOVER_STATUS_LABEL = { DRAFT: 'Бэлдэж байна', PREPARED: 'Бэлдсэн', HANDED_OVER: 'Жолооч хүлээн авна', RECEIVED: 'Жолооч хүлээн авсан' } as const;
/** Агуулах барааг өгсөн (жолооч хүлээн авсан эсэхээс үл хамааран) — падаанд захиалга нэмэх/хасахгүй */
export const isGiven = (s: string) => s === 'HANDED_OVER' || s === 'RECEIVED';

export function cleanYmd(v: unknown, label = 'Огноо'): string {
  const s = String(v ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw badRequest(`${label} буруу`, 'bad_date');
  return s;
}
export function addDays(ymd: string, n: number): string {
  return ymdOf(new Date(Date.parse(ymd) + n * 86_400_000));
}
export const todayYmd = () => ubDay();

export async function nextHandoverNumber(tx: Tx): Promise<string> {
  const r = await tx.$queryRaw<{ n: string }[]>`SELECT 'П-' || lpad(nextval('handover_number_seq')::text, 6, '0') AS n`;
  return r[0]!.n;
}

/** Үндсэн агуулах (тавиуртай) — падааны бараа эндээс гарна */
export async function primaryWarehouse(tx: Tx | typeof db) {
  const w = await tx.warehouse.findFirst({ where: { isPrimary: true, isActive: true }, include: { location: true } });
  if (!w || !w.location) throw badRequest('Үндсэн агуулах тохируулаагүй байна (Агуулах → Агуулахууд)', 'no_primary_warehouse');
  return { warehouse: w, locationId: w.location.id };
}

/** Жолоочийн гарт байгаа бараа (газар) — хэрэгтэй үед үүснэ */
export async function driverLocationId(tx: Tx, driver: { id: string; name: string }): Promise<number> {
  const l = await tx.stockLocation.upsert({
    where: { kind_userId: { kind: 'DRIVER', userId: driver.id } },
    create: { kind: 'DRIVER', userId: driver.id, name: `Жолооч: ${driver.name}` },
    update: {},
    select: { id: true },
  });
  return l.id;
}

/**
 * Захиалгыг падаанаас (өгөхөөс өмнө) хасна: мөр түүхэнд «хасагдсан» болж үлдэнэ (агуулахад улаанаар — тавиурт буцаах),
 * тухайн захиалгын барааны Check арилна (тоо өөрчлөгдсөн тул дахин шалгана). Өгсөн падаанд хэрэглэхгүй.
 */
export async function removeFromHandover(tx: Tx, orderId: number, reason: string) {
  const o = await tx.order.findUnique({ where: { id: orderId }, select: { handoverId: true, lines: { select: { variantId: true } } } });
  if (!o?.handoverId) return;
  const h = await tx.handover.findUnique({ where: { id: o.handoverId }, select: { status: true } });
  if (h && isGiven(h.status)) throw badRequest('Падаан өгөгдсөн захиалга — агуулах падааныг «Буцаах»-аас өмнө өөрчлөх боломжгүй', 'handed_over');
  await tx.handoverOrder.updateMany({ where: { handoverId: o.handoverId, orderId, removedAt: null }, data: { removedAt: new Date(), removeReason: reason } });
  await tx.handoverCheck.deleteMany({ where: { handoverId: o.handoverId, kind: 'ORDER', variantId: { in: o.lines.map((l) => l.variantId) } } });
  await tx.handover.update({ where: { id: o.handoverId }, data: { version: { increment: 1 } } });
  await tx.order.update({ where: { id: orderId }, data: { handoverId: null } });
}

/** Падаанд захиалга нэмэх (өгөхөөс өмнө) — «ШИНЭ» тэмдэгтэй, тухайн барааны Check арилна */
export async function addToHandover(tx: Tx, handoverId: number, orderId: number) {
  const max = await tx.handoverOrder.aggregate({ where: { handoverId }, _max: { position: true } });
  const existing = await tx.handoverOrder.findUnique({ where: { handoverId_orderId: { handoverId, orderId } } });
  if (existing) await tx.handoverOrder.update({ where: { id: existing.id }, data: { removedAt: null, removeReason: null, addedAt: new Date() } });
  else await tx.handoverOrder.create({ data: { handoverId, orderId, position: (max._max.position ?? 0) + 1 } });
  const lines = await tx.orderLine.findMany({ where: { orderId }, select: { variantId: true } });
  await tx.handoverCheck.deleteMany({ where: { handoverId, kind: 'ORDER', variantId: { in: lines.map((l) => l.variantId) } } });
  await tx.handover.update({ where: { id: handoverId }, data: { version: { increment: 1 } } });
  await tx.order.update({ where: { id: orderId }, data: { handoverId } });
}

/** Жолоочийн тухайн өдрийн OKEY: тэмдэглэл байвал түүгээр, үгүй бол «итгэлтэй» бол OKEY */
export async function approvalFor(tx: Tx | typeof db, driverId: string, ymd: string): Promise<{ approved: boolean; source: 'manual' | 'trusted' | 'none'; note: string | null; byName: string | null }> {
  const [a, s] = await Promise.all([
    tx.driverApproval.findUnique({ where: { driverId_date: { driverId, date: dateOnly(ymd) } } }),
    tx.driverSetting.findUnique({ where: { userId: driverId } }),
  ]);
  if (a) return { approved: a.approved, source: 'manual', note: a.note, byName: a.byName };
  if (s?.trusted) return { approved: true, source: 'trusted', note: null, byName: null };
  return { approved: false, source: 'none', note: null, byName: null };
}
