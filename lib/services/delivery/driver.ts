import type { DeliveryPayment, IssueFault, IssueType, Order, OrderLine, Prisma } from '@prisma/client';
import { db } from '../../db';
import { badRequest, conflict, forbidden, notFound } from '../../errors';
import { writeAudit } from '../../audit';
import { canDrive, canResolveIssues, canView } from '../../permissions';
import { dateOnly, ubDay, ubDayStart, ymdOf } from '../../ubdate';
import { applyMoves, stockCache } from '../stock/core';
import { inTx, lockOrder, requireReason, type UserActor } from '../orders/core';
import { bustCounts, serializeOrder } from '../orders/queries';
import { skipMeta } from '../orders/meta';
import { assignCore } from './assign';
import { addDays, driverLocationId, isGiven, lockDelivery, removeFromHandover, type Tx } from './core';
import { assertDayOpen } from '../accounting/lock';
import { syncShortageDebts } from '../accounting/debts';
import { computeDay } from '../accounting/calc';
import { autoPenaltyForIssue } from '../penalties';

/**
 * Модуль 5 — жолоочийн апп (хуучин ERP-ийн урсгал, #73/#74). Бараа бүр нэг журналаар (B2):
 *   «Хүргэсэн»            жолооч → үйлчлүүлэгч (DELIVERY), болиулсан бараа жолоочид үлдэнэ
 *   «Цуцлах», «Маргааш»   бараа жолоочид үлдэнэ → агуулах «Буцаалт хүлээн авах» (DRIVER_RETURN)
 *   «Цуцлах (буцаах)»     үйлчлүүлэгч → жолооч (DELIVERY_BACK)
 * Жолоочид байгаа бараа = хүргэлтэд явж буй захиалгынх (held) + буцаах (returnable). returnable = үлдэгдэл − held ≥ 0.
 * Бүх үйлдэл хүргэлтийн нийтлэг түгжээ → захиалга → бараа дарааллаар (Модуль 4-тэй ижил, deadlock-гүй), давхар дарахад нэг удаа.
 */
export const MAX_POSTPONE = 2;
export const PAYMENT_LABEL: Record<DeliveryPayment, string> = { CASH: 'Бэлэн', BANK: 'Данс', UNPAID: 'Төлөөгүй (өрийн дэвтэрт)', PREPAID: 'Урьдчилж төлсөн' };
export const ISSUE_LABEL: Record<IssueType, string> = { WRONG_PRODUCT: 'Бараа буруу', WRONG_NUMBER: 'Дугаар буруу', UNCLEAR_ADDRESS: 'Хаяг тодорхойгүй' };
export const FAULT_LABEL: Record<IssueFault, string> = { OPERATOR: 'Опп-н алдаа', DRIVER: 'Жолоочийн алдаа', MARKETING: 'Маркетингийн алдаа', WAREHOUSE: 'Агуулахын алдаа' };

const assertDriver = (a: UserActor) => { if (!canDrive(a.roles)) throw forbidden('Энэ үйлдлийг жолооч хийнэ'); };
type OrderL = Order & { lines: OrderLine[] };
/** Модуль 6: нягтлангийн «Төлөв солих» — жолоочийн нэрийн өмнөөс (эрхийг дуудагч шалгана) */
export interface OnBehalf { accountant: true }
const driverOf = (o: Order, actor: UserActor, ob?: OnBehalf) => (ob ? { id: o.driverId!, name: o.driverName ?? '' } : { id: actor.id, name: actor.name });
const byName = (actor: UserActor, ob?: OnBehalf) => (ob ? `${actor.name} (нягтлан)` : actor.name);

function cleanId(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw notFound('Захиалга олдсонгүй');
  return n;
}

/** Түгжээд, өөрийн захиалгыг уншина (өөр жолоочийнх бол 404 — хэн нэгний захиалгыг харуулахгүй) */
async function loadOwn(tx: Tx, actor: UserActor, id: number, by: 'driver' | 'postponed' = 'driver', ob?: OnBehalf): Promise<OrderL> {
  await lockDelivery(tx);
  if (!(await lockOrder(tx, id))) throw notFound('Захиалга олдсонгүй');
  const o = await tx.order.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { id: 'asc' } } } });
  const owner = by === 'driver' ? o.driverId : o.postponedByDriverId;
  if (ob ? !owner : owner !== actor.id) throw notFound('Захиалга олдсонгүй');
  return o;
}

function checkVersion(o: Order, v: unknown) {
  if (v !== undefined && v !== null && Number(v) !== o.version) throw conflict('Захиалга өөрчлөгдсөн байна — дахин ачаална уу', 'stale');
}
function noPendingIssue(o: Order) {
  if (o.issueStatus === 'PENDING') throw conflict('Асуудал шийдэгдэж байна — ахлах оператор шийдвэрлэх хүртэл хүлээнэ үү', 'issue_pending');
}

/** Жолоочийн гарт байгаа бараа: үлдэгдэл, хүргэлтэд явж буй захиалгынх (held), буцаах (returnable) */
export async function driverGoods(tx: Tx | typeof db, driverId: string) {
  const loc = await tx.stockLocation.findUnique({ where: { kind_userId: { kind: 'DRIVER', userId: driverId } }, select: { id: true } });
  const [bal, held] = await Promise.all([
    loc ? tx.stockBalance.findMany({ where: { locationId: loc.id, qty: { gt: 0 } }, select: { variantId: true, qty: true } }) : Promise.resolve([]),
    tx.$queryRaw<{ variantId: number; qty: number }[]>`
      SELECT l."variantId", sum(l.qty)::int AS qty FROM "OrderLine" l JOIN "Order" o ON o.id = l."orderId"
      WHERE o.status = 'OUT_FOR_DELIVERY' AND o."driverId" = ${driverId}::uuid GROUP BY 1`,
  ]);
  const balance = new Map(bal.map((b) => [b.variantId, b.qty]));
  const heldM = new Map(held.map((h) => [h.variantId, h.qty]));
  const returnable = new Map<number, number>();
  for (const [v, q] of balance) { const r = q - (heldM.get(v) ?? 0); if (r > 0) returnable.set(v, r); }
  return { locationId: loc?.id ?? null, balance, held: heldM, returnable };
}

/** Жолоочид буцаах бараа хүрэлцэх эсэх (өөр захиалгын бараанд хүрэхгүй) */
async function assertReturnable(tx: Tx, driverId: string, need: Map<number, number>, labels: Map<number, string>) {
  const g = await driverGoods(tx, driverId);
  for (const [v, q] of need) {
    const have = g.returnable.get(v) ?? 0;
    if (q > have) throw conflict(`«${labels.get(v) ?? `#${v}`}» жолоочид ${have} байна (хэрэгтэй ${q}) — бараа агуулахад буцсан эсвэл өөр захиалгад`, 'goods_not_with_driver');
  }
}

function recompute(o: OrderL, taken: Map<number, number>) {
  let subtotal = 0; let discount = 0;
  for (const l of o.lines) { const q = taken.get(l.id) ?? 0; subtotal += l.listPrice * q; discount += (l.listPrice - l.unitPrice) * q; }
  return { subtotal, discount, total: subtotal - discount + o.deliveryFee };
}

function cleanPayment(o: Order, payment: unknown, noteIn: unknown): { payment: DeliveryPayment; note: string | null } {
  if (o.prepaid) return { payment: 'PREPAID', note: requireReason(noteIn, 'note_required') };
  const p = String(payment ?? '');
  if (!['CASH', 'BANK', 'UNPAID'].includes(p)) throw badRequest('Төлбөрөө сонгоно уу: Бэлэн / Данс / Төлөөгүй', 'payment_required');
  const note = String(noteIn ?? '').trim().slice(0, 500) || null;
  return { payment: p as DeliveryPayment, note };
}

/** taken: { lineId: авсан тоо } — өгөөгүй мөр = бүгдийг авсан */
function cleanTaken(o: OrderL, input: unknown): Map<number, number> {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const m = new Map<number, number>();
  for (const l of o.lines) {
    const v = raw[String(l.id)];
    const q = v === undefined ? l.qty : Number(v);
    if (!Number.isInteger(q) || q < 0 || q > l.qty) throw badRequest(`«${l.name}» тоо буруу (0–${l.qty})`);
    m.set(l.id, q);
  }
  if ([...m.values()].every((q) => q === 0)) throw badRequest('Бүх барааг болиулсан бол «Цуцлах» дарна уу', 'nothing_taken');
  return m;
}

function bust() { stockCache.today = null; bustCounts(); }

// ───────────────────────── Хүргэсэн ─────────────────────────

/**
 * «Хүргэсэн» (хуучин шиг: «Үйлчлүүлэгч мөнгөө өгсөн үү?» → Бэлэн / Данс / Төлөөгүй; урьдчилж төлсөнд тайлбар).
 * Болиулсан барааг чагтаа авна (#73 3): дүн автоматаар, болиулсан бараа жолоочид үлдэж буцаах жагсаалтад.
 * Мөн цуцалсан захиалгыг «Хүргэсэн болгох» (бараа жолоочид байгаа үед л).
 */
export async function deliverOrder(actor: UserActor, idIn: unknown, input: { taken?: unknown; payment?: unknown; note?: unknown; version?: unknown }, ob?: OnBehalf) {
  if (!ob) assertDriver(actor);
  const id = cleanId(idIn);
  const r = await inTx(async (tx) => {
    const o = await loadOwn(tx, actor, id, 'driver', ob);
    if (o.status === 'DELIVERED') return { order: o, duplicate: true };
    await assertDayOpen(tx, o.handoverId, { allowPending: !!ob });
    const drv = driverOf(o, actor, ob);
    const recover = o.status === 'CANCELLED';
    if (recover) {
      if (!o.outForDeliveryAt || !['DRIVER_CANCELLED', 'ISSUE'].includes(o.cancelReason ?? '')) throw conflict('Энэ цуцлалтын бараа жолоочид өгөгдөөгүй — «Хүргэсэн болгох» боломжгүй', 'bad_status');
    } else if (o.status === 'ASSIGNED') throw conflict('Падаанаа хүлээн аваагүй байна — «Падаан» табаас бараагаа чагтлаад «Барааг бүрэн хүлээн авсан» дарна уу', 'not_handed_over');
    else if (o.status !== 'OUT_FOR_DELIVERY') throw conflict('Энэ захиалгыг хүргэх боломжгүй', 'bad_status');
    checkVersion(o, input.version);
    noPendingIssue(o);
    const taken = cleanTaken(o, input.taken);
    const pay = cleanPayment(o, input.payment, input.note);
    const labels = new Map(o.lines.map((l) => [l.variantId, `${l.name}${l.label ? ` · ${l.label}` : ''}`]));
    const need = new Map<number, number>();
    for (const l of o.lines) { const q = taken.get(l.id) ?? 0; if (q) need.set(l.variantId, (need.get(l.variantId) ?? 0) + q); }
    // «Хүргэсэн болгох»: бараа нь буцаах жагсаалтад (агуулахад буцаагаагүй) байх ёстой
    if (recover) await assertReturnable(tx, drv.id, need, labels);
    const fromId = await driverLocationId(tx, drv);
    await applyMoves(tx, actor, { type: 'order', id }, [...need].map(([variantId, qty]) => ({ type: 'DELIVERY' as const, variantId, qty, fromId, toId: null, note: `№${o.number} хүргэсэн` })), labels);
    for (const l of o.lines) {
      const refused = l.qty - (taken.get(l.id) ?? 0);
      if (refused !== l.refusedQty) await tx.orderLine.update({ where: { id: l.id }, data: { refusedQty: refused } });
    }
    const sum = recompute(o, taken);
    const collect = pay.payment === 'CASH' || pay.payment === 'BANK' ? sum.total : 0;
    const u = await tx.order.update({
      where: { id },
      data: {
        status: 'DELIVERED', deliveredAt: new Date(), deliveredByName: byName(actor, ob), deliveryPayment: pay.payment, deliveryNote: pay.note, collectAmount: collect,
        originalTotal: o.originalTotal ?? o.total, subtotal: sum.subtotal, discount: sum.discount, total: sum.total,
        ...(recover ? { cancelReason: null, cancelNote: null, cancelledAt: null, cancelledByName: null } : {}),
        version: { increment: 1 },
      },
    });
    if (recover) await syncShortageDebts(tx, drv.id);
    // «Төлөөгүй» → жолоочийн ХУВИЙН өрийн дэвтэр (хуучин шиг, нягтлантай холбоогүй — #79)
    if (pay.payment === 'UNPAID') await tx.driverDebt.create({ data: { orderId: id, driverId: drv.id, orderNumber: o.number, phone: o.phone, amount: sum.total } });
    const refused = o.lines.filter((l) => (taken.get(l.id) ?? 0) < l.qty).map((l) => ({ name: labels.get(l.variantId), qty: l.qty - (taken.get(l.id) ?? 0) }));
    await writeAudit(actor, recover ? 'order.redelivered' : 'order.delivered', 'Order', String(id), {
      number: o.number, ...(ob ? { byAccountant: true, driver: drv.name } : {}), payment: pay.payment, total: sum.total, collect, ...(refused.length ? { refused, totalBefore: o.originalTotal ?? o.total } : {}), ...(pay.note ? { note: pay.note } : {}),
    } as Prisma.InputJsonValue, tx, ['order', 'delivery', 'money', 'stock']);
    // Аудит Б15 (эзний шийдвэр): асуудлаар цуцлагдсаныг дахин хүргэвэл тэр асуудлаас үүссэн автомат торгууль (цалингаас хасаагүй) цуцлагдана
    if (recover && o.cancelReason === 'ISSUE') {
      const pens = await tx.penalty.findMany({ where: { orderId: o.id, auto: true, status: 'ACTIVE', deducted: false, deductedAmount: 0 } });
      for (const pn of pens) {
        const c = await tx.penalty.updateMany({ where: { id: pn.id, status: 'ACTIVE', deducted: false, deductedAmount: 0 }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledByName: 'СИСТЕМ', cancelNote: `Захиалга №${o.number} дахин хүргэгдсэн`, version: { increment: 1 } } });
        if (c.count) await writeAudit({ id: null, name: 'СИСТЕМ' }, 'penalty.cancelled', 'Penalty', String(pn.id), { user: pn.userName, category: pn.category, amount: pn.amount, note: `Захиалга №${o.number} дахин хүргэгдсэн (автомат)` }, tx, ['penalty', 'money']);
      }
    }
    return { order: u, duplicate: false };
  });
  bust();
  // Аудит Б7: урьдчилж төлсөн захиалгыг хэсэгчлэн хүргэвэл банкны гүйлгээ «Илүү» болж «Банк импорт → Илүү»-д гарна
  if (!r.duplicate && r.order.prepaid) await bankRestatus(r.order.id);
  return r;
}

async function bankRestatus(orderId: number) {
  try { const { restatusOrder } = await import('../accounting/bank'); await restatusOrder(orderId); } catch (e) { console.error('[bank] restatus', (e as Error).message); }
}

/** «Цуцлах (буцаах)» хүргэсэн захиалгыг: бараа үйлчлүүлэгчээс жолоочид буцна (DELIVERY_BACK), дүн анхны хэмжээнд */
export async function undoDelivery(actor: UserActor, idIn: unknown, input: { note?: unknown; version?: unknown }, ob?: OnBehalf) {
  if (!ob) assertDriver(actor);
  const id = cleanId(idIn);
  const note = requireReason(input.note);
  const r = await inTx(async (tx) => {
    const o = await loadOwn(tx, actor, id, 'driver', ob);
    if (o.status === 'CANCELLED') return { order: o, duplicate: true };
    if (o.status !== 'DELIVERED') throw conflict('Зөвхөн хүргэсэн захиалгыг буцаана', 'bad_status');
    checkVersion(o, input.version);
    await assertDayOpen(tx, o.handoverId, { allowPending: !!ob });
    const drv = driverOf(o, actor, ob);
    // Жолооч: хүргэсэн өдөр эсвэл маргааш нь л (нягтлан аль ч өдөр — тооцоо баталгаажаагүй бол)
    if (!ob && o.deliveredAt && ymdOf(new Date(o.deliveredAt.getTime() + 8 * 3600_000)) < ubDay(new Date(), -1)) throw conflict('2 хоногоос өмнө хүргэсэн захиалгыг ахлах жолооч / нягтлан шийднэ', 'too_old');
    const labels = new Map(o.lines.map((l) => [l.variantId, l.name]));
    const toId = await driverLocationId(tx, drv);
    const back = o.lines.map((l) => ({ type: 'DELIVERY_BACK' as const, variantId: l.variantId, qty: l.qty - l.refusedQty, fromId: null, toId, note: `№${o.number} хүргэсний дараа буцаасан` }));
    await applyMoves(tx, actor, { type: 'order', id }, back, labels);
    await tx.orderLine.updateMany({ where: { orderId: id }, data: { refusedQty: 0 } });
    // Хүргэлт буцсан тул өрийн дэвтрээс хасна (төлөөгүй мөр)
    await tx.driverDebt.updateMany({ where: { orderId: id, paidAt: null, cancelledAt: null }, data: { cancelledAt: new Date() } });
    const full = recompute(o, new Map(o.lines.map((l) => [l.id, l.qty])));
    const u = await tx.order.update({
      where: { id },
      data: {
        status: 'CANCELLED', cancelReason: 'DRIVER_CANCELLED', cancelNote: note, cancelledAt: new Date(), cancelledByName: byName(actor, ob),
        deliveredAt: null, deliveryPayment: null, collectAmount: null, deliveryNote: null, subtotal: full.subtotal, discount: full.discount, total: full.total,
        version: { increment: 1 },
      },
    });
    await writeAudit(actor, 'order.delivery_undone', 'Order', String(id), { number: o.number, note, ...(ob ? { byAccountant: true, driver: drv.name } : {}), payment: o.deliveryPayment, total: o.total }, tx, ['order', 'delivery', 'money', 'stock']);
    return { order: u, duplicate: false };
  });
  bust();
  if (!r.duplicate && r.order.prepaid) await bankRestatus(r.order.id);
  return r;
}

// ───────────────────────── Цуцлах ─────────────────────────

/** «Цуцлах» (шалтгаан 5+). Бараа жолоочид өгөгдсөн бол түүнд үлдэж буцаах жагсаалтад; өгөөгүй бол нөөц суллагдана */
export async function driverCancel(actor: UserActor, idIn: unknown, input: { note?: unknown; blacklist?: unknown; version?: unknown }, ob?: OnBehalf) {
  if (!ob) assertDriver(actor);
  const id = cleanId(idIn);
  const note = requireReason(input.note);
  const r = await inTx(async (tx) => {
    const o = await loadOwn(tx, actor, id, 'driver', ob);
    if (o.status === 'CANCELLED') return { order: o, duplicate: true };
    await assertDayOpen(tx, o.handoverId, { allowPending: !!ob });
    if (o.status === 'ASSIGNED') throw conflict('Падаанаа хүлээн авсны дараа цуцална (бараа хүлээн аваагүй бол ахлах жолоочид хэлнэ)', 'not_received');
    if (o.status !== 'OUT_FOR_DELIVERY') throw conflict('Энэ захиалгыг цуцлах боломжгүй', 'bad_status');
    checkVersion(o, input.version);
    noPendingIssue(o);
    await cancelCore(tx, o, byName(actor, ob), 'DRIVER_CANCELLED', note);
    if (!ob && (input.blacklist === true || input.blacklist === 'true')) {
      const exists = await tx.blacklistEntry.findFirst({ where: { phone: o.phone, isActive: true } });
      if (!exists) await tx.blacklistEntry.create({ data: { phone: o.phone, reason: `[МӨНГӨ ӨГДӨГГҮЙ ХҮН] ${note}`, orderNumber: o.number, reportedById: actor.id, reportedBy: actor.name } });
      await writeAudit(actor, 'blacklist.added', 'Blacklist', o.phone, { phone: o.phone, reason: note, orderNumber: o.number, by: 'driver' }, tx, ['order']);
    }
    await writeAudit(actor, 'order.driver_cancelled', 'Order', String(id), { number: o.number, from: o.status, note, ...(ob ? { byAccountant: true, driver: o.driverName } : {}), goodsWithDriver: o.status === 'OUT_FOR_DELIVERY' }, tx, ['order', 'cancel', 'delivery']);
    return { order: await tx.order.findUniqueOrThrow({ where: { id } }), duplicate: false };
  });
  bust();
  return r;
}

async function cancelCore(tx: Tx, o: Order, byName: string, reason: 'DRIVER_CANCELLED' | 'ISSUE', note: string) {
  if (o.status === 'ASSIGNED') {
    // Бараа агуулахад: нөөц суллаж, падаанаас (өгөхөөс өмнө) хасна
    await tx.stockReservation.deleteMany({ where: { orderId: o.id } });
    if (o.handoverId) await removeFromHandover(tx, o.id, 'Цуцлагдсан');
  }
  await tx.order.update({ where: { id: o.id }, data: { status: 'CANCELLED', cancelReason: reason, cancelNote: note, cancelledAt: new Date(), cancelledByName: byName, version: { increment: 1 } } });
  await skipMeta(tx, o.id);
}

// ───────────────────────── Маргааш ─────────────────────────

/**
 * «Маргааш» (#46, #73): ижил дугаартай «Шинэ», хүргэх өдөр = маргааш, жолоочгүй — ахлах жолооч дурын жолоочид оноож, эсвэл жолооч өөрөө авна.
 * Бараа жолоочид үлдэж агуулахад буцна; агуулахад нөөц дахин тавигдана (давхар зарагдахгүй). 2 удаа, дараа нь цоож.
 */
export async function postponeOrder(actor: UserActor, idIn: unknown, input: { version?: unknown }) {
  assertDriver(actor);
  const id = cleanId(idIn);
  const r = await inTx(async (tx) => {
    await lockDelivery(tx);
    if (!(await lockOrder(tx, id))) throw notFound('Захиалга олдсонгүй');
    const o = await tx.order.findUniqueOrThrow({ where: { id }, include: { lines: true } });
    // Давхар дарахад: аль хэдийн энэ жолооч хойшлуулсан
    if (o.status === 'NEW' && o.postponedByDriverId === actor.id && o.postponedAt && Date.now() - o.postponedAt.getTime() < 60_000) return { order: o, duplicate: true };
    if (o.driverId !== actor.id) throw notFound('Захиалга олдсонгүй');
    if (o.status === 'ASSIGNED') throw conflict('Падаанаа хүлээн авсны дараа «Маргааш» дарна (хүлээн аваагүй бол ахлах жолоочид хэлнэ)', 'not_received');
    if (o.status !== 'OUT_FOR_DELIVERY') throw conflict('Энэ захиалгыг хойшлуулах боломжгүй', 'bad_status');
    checkVersion(o, input.version);
    await assertDayOpen(tx, o.handoverId);
    noPendingIssue(o);
    if (o.postponeCount >= MAX_POSTPONE) throw conflict(`«Маргааш» ${MAX_POSTPONE} удаа дарагдсан тул цоожтой — ахлах жолооч / оператор шийднэ`, 'postpone_locked');
    if (o.status === 'OUT_FOR_DELIVERY') {
      // Бараа жолоочид: падааны мөр түүхэнд «Маргааш» гэж үлдэнэ; агуулахад нөөц дахин
      if (o.handoverId) await tx.handoverOrder.updateMany({ where: { handoverId: o.handoverId, orderId: id, removedAt: null }, data: { removedAt: new Date(), removeReason: 'Маргааш (бараа жолоочид)' } });
      await tx.stockReservation.createMany({ data: o.lines.map((l) => ({ ref: `order:${id}`, orderId: id, variantId: l.variantId, qty: l.qty })) });
    } else if (o.handoverId) await removeFromHandover(tx, id, 'Маргааш');
    const u = await tx.order.update({
      where: { id },
      data: {
        status: 'NEW', deliveryDate: dateOnly(ubDay(new Date(), 1)), driverId: null, driverName: null, assignedAt: null, handoverId: null,
        // Бараа жолоочид өгөгдсөн эсэхийг «буцаах»-д ашиглана (өгөөгүй бол хоосон)
        outForDeliveryAt: o.status === 'OUT_FOR_DELIVERY' ? o.outForDeliveryAt : null,
        postponeCount: { increment: 1 }, postponedAt: new Date(), postponedByDriverId: actor.id, postponedByName: actor.name, routeNo: null,
        version: { increment: 1 },
      },
    });
    await writeAudit(actor, 'order.postponed', 'Order', String(id), { number: o.number, count: o.postponeCount + 1, from: o.status, goodsWithDriver: o.status === 'OUT_FOR_DELIVERY' }, tx, ['order', 'delivery']);
    return { order: u, duplicate: false };
  });
  bust();
  return r;
}

/** «Маргааш»-ийг андуурч дарсан бол буцаах — өнөөдөр, хэн ч дахин хуваарилаагүй, бараа нь жолоочид байгаа үед */
export async function undoPostpone(actor: UserActor, idIn: unknown) {
  assertDriver(actor);
  const id = cleanId(idIn);
  const r = await inTx(async (tx) => {
    const o = await loadOwn(tx, actor, id, 'postponed');
    if (o.status !== 'NEW' || o.driverId) throw conflict('Захиалга аль хэдийн хуваарилагдсан / өөрчлөгдсөн — ахлах жолоочид хандана уу', 'already_reassigned');
    if (!o.postponedAt || ymdOf(new Date(o.postponedAt.getTime() + 8 * 3600_000)) !== ubDay()) throw conflict('Зөвхөн өнөөдөр хойшлуулсныг буцаана', 'too_old');
    const today = ubDay();
    const hadGoods = !!o.outForDeliveryAt;
    const hoP = await tx.handoverOrder.findFirst({ where: { orderId: id, removeReason: 'Маргааш (бараа жолоочид)' }, orderBy: { id: 'desc' }, select: { handoverId: true } });
    await assertDayOpen(tx, hoP?.handoverId);
    // Падаан буцаагдсан бол (бараа агуулахад буцсан) «Маргааш»-ыг буцаахгүй (#124-Д) — захиалга «Шинэ» хэвээр, ахлах дахин хуваарилна
    if (hadGoods && hoP) {
      const h = await tx.handover.findUnique({ where: { id: hoP.handoverId }, select: { status: true } });
      if (!h || !isGiven(h.status)) throw conflict('Падаан буцаагдсан тул «Маргааш»-ыг буцаах боломжгүй — ахлах жолоочид хандана уу', 'handover_reverted');
    }
    if (hadGoods) {
      const need = new Map<number, number>();
      for (const l of o.lines) need.set(l.variantId, (need.get(l.variantId) ?? 0) + l.qty);
      await assertReturnable(tx, actor.id, need, new Map(o.lines.map((l) => [l.variantId, l.name])));
      await tx.stockReservation.deleteMany({ where: { orderId: id } });
      const ho = await tx.handoverOrder.findFirst({ where: { orderId: id, removeReason: 'Маргааш (бараа жолоочид)' }, orderBy: { id: 'desc' } });
      if (ho) await tx.handoverOrder.update({ where: { id: ho.id }, data: { removedAt: null, removeReason: null } });
      await tx.order.update({
        where: { id },
        data: { status: 'OUT_FOR_DELIVERY', driverId: actor.id, driverName: actor.name, assignedAt: new Date(), deliveryDate: dateOnly(today), handoverId: ho?.handoverId ?? null,
          postponeCount: { decrement: 1 }, postponedAt: null, postponedByDriverId: null, postponedByName: null, version: { increment: 1 } },
      });
      await syncShortageDebts(tx, actor.id);
    } else {
      await tx.order.update({ where: { id }, data: { postponeCount: { decrement: 1 }, postponedAt: null, postponedByDriverId: null, postponedByName: null, deliveryDate: dateOnly(today) } });
    }
    await writeAudit(actor, 'order.postpone_undone', 'Order', String(id), { number: o.number }, tx, ['order', 'delivery']);
    return { hadGoods };
  });
  // Бараа аваагүй байсан бол ердийн хуваарилалтаар буцааж авна (падааны дүрэм хэвээр)
  if (!r.hadGoods) await assignCore(actor, [id], { id: actor.id, name: actor.name }, { pickup: true });
  bust();
  return { order: await db.order.findUniqueOrThrow({ where: { id } }) };
}

// ───────────────────────── Асуудал («Опп-руу явуулах») ─────────────────────────

export async function reportIssue(actor: UserActor, idIn: unknown, input: { type?: unknown; note?: unknown }) {
  assertDriver(actor);
  const id = cleanId(idIn);
  const type = String(input.type ?? '') as IssueType;
  if (!(type in ISSUE_LABEL)) throw badRequest('Асуудлын төрлөө сонгоно уу');
  const note = String(input.note ?? '').trim().slice(0, 500) || null;
  const r = await inTx(async (tx) => {
    const o = await loadOwn(tx, actor, id);
    if (o.issueStatus === 'PENDING') return { order: o, duplicate: true };
    if (o.status === 'ASSIGNED') throw conflict('Падаанаа хүлээн авсны дараа', 'not_received');
    if (o.status !== 'OUT_FOR_DELIVERY') throw conflict('Энэ захиалгад асуудал мэдэгдэх боломжгүй', 'bad_status');
    const u = await tx.order.update({
      where: { id },
      data: { issueType: type, issueNote: note, issueAt: new Date(), issueStatus: 'PENDING', issueFault: null, issueResolvedAt: null, issueResolvedByName: null, issueResolveNote: null, version: { increment: 1 } },
    });
    await writeAudit(actor, 'order.issue_reported', 'Order', String(id), { number: o.number, type, note }, tx, ['order', 'delivery', 'issue']);
    return { order: u, duplicate: false };
  });
  issueCountCache = null;
  return r;
}

/** Ахлах оператор: «Зассан» (жолооч үргэлжлүүлнэ, тайлбар нь жолоочид харагдана) эсвэл «Цуцлах» (хэний алдаа) */
export async function resolveIssue(actor: UserActor, idIn: unknown, input: { action?: unknown; note?: unknown; fault?: unknown }) {
  if (!canResolveIssues(actor.roles)) throw forbidden('Асуудлыг ахлах оператор, админ шийднэ');
  const id = cleanId(idIn);
  const action = String(input.action ?? '');
  if (!['fix', 'cancel'].includes(action)) throw badRequest('Шийдвэрээ сонгоно уу');
  const note = requireReason(input.note);
  const fault = action === 'cancel' ? (String(input.fault ?? '') as IssueFault) : null;
  if (fault !== null && !(fault in FAULT_LABEL)) throw badRequest('Хэний алдаа болохыг сонгоно уу', 'fault_required');
  const r = await inTx(async (tx) => {
    await lockDelivery(tx);
    if (!(await lockOrder(tx, id))) throw notFound('Захиалга олдсонгүй');
    const o = await tx.order.findUniqueOrThrow({ where: { id } });
    if (o.issueStatus !== 'PENDING') return { order: o, duplicate: true, penaltyWarning: null as string | null };
    let penaltyWarning: string | null = null;
    const base = { issueResolvedAt: new Date(), issueResolvedByName: actor.name, issueResolveNote: note };
    if (action === 'fix') {
      await tx.order.update({ where: { id }, data: { ...base, issueStatus: 'FIXED', version: { increment: 1 } } });
    } else {
      if (!['ASSIGNED', 'OUT_FOR_DELIVERY'].includes(o.status)) throw conflict('Захиалгын төлөв өөрчлөгдсөн байна', 'bad_status');
      await cancelCore(tx, o, actor.name, 'ISSUE', `${FAULT_LABEL[fault!]}: ${note}`);
      await tx.order.update({ where: { id }, data: { ...base, issueStatus: 'CANCELLED', issueFault: fault } });
      // Модуль 7а (#90): хэний алдаагаар автомат торгууль (хуучин шиг; жолоочийн алдаа → торгуульгүй)
      penaltyWarning = await autoPenaltyForIssue(tx, actor, o, fault!);
    }
    await writeAudit(actor, action === 'fix' ? 'order.issue_fixed' : 'order.issue_cancelled', 'Order', String(id), { number: o.number, note, ...(fault ? { fault } : {}) }, tx, ['order', 'delivery', 'issue']);
    return { order: await tx.order.findUniqueOrThrow({ where: { id } }), duplicate: false, penaltyWarning };
  });
  issueCountCache = null; bust();
  return r;
}

export async function listIssues(actor: UserActor, p: { status?: string; page?: number }) {
  if (!canView(actor.roles, 'issues')) throw forbidden();
  const pending = (p.status ?? 'pending') === 'pending';
  const page = Math.max(1, Math.min(500, Math.floor(p.page ?? 1)));
  const where: Prisma.OrderWhereInput = pending ? { issueStatus: 'PENDING' } : { issueStatus: { in: ['FIXED', 'CANCELLED'] } };
  const rows = await db.order.findMany({ where, orderBy: pending ? { issueAt: 'asc' } : { issueResolvedAt: 'desc' }, skip: (page - 1) * 50, take: 51, include: { lines: true } });
  return {
    page, hasMore: rows.length > 50, canResolve: canResolveIssues(actor.roles), pending: await pendingIssueCount(),
    items: rows.slice(0, 50).map((o) => ({ ...serializeOrder(o), issueLabel: o.issueType ? ISSUE_LABEL[o.issueType] : null, faultLabel: o.issueFault ? FAULT_LABEL[o.issueFault] : null })),
  };
}

let issueCountCache: { at: number; n: number } | null = null;
/** Цэсний тэмдэгт: шийдэгдээгүй асуудал */
export async function pendingIssueCount(): Promise<number> {
  if (issueCountCache && Date.now() - issueCountCache.at < 15_000) return issueCountCache.n;
  const n = await db.order.count({ where: { issueStatus: 'PENDING' } });
  issueCountCache = { at: Date.now(), n };
  return n;
}

// ───────────────────────── Жолоочийн жагсаалт ─────────────────────────

export type DriverTab = 'all' | 'delivery' | 'delivered' | 'cancelled' | 'tomorrow' | 'yesterday';

/** Жолоочийн табууд (хуучин шиг). Захиалгыг ХҮРГЭХ ӨДӨР + жолоочоор сонгоно (хуучны «үүссэн өдөр» алдаагүй) */
export async function driverOrders(actor: UserActor, tabIn?: string) {
  assertDriver(actor);
  const tab = (['all', 'delivery', 'delivered', 'cancelled', 'tomorrow', 'yesterday'].includes(tabIn ?? '') ? tabIn : 'all') as DriverTab;
  const today = ubDay(); const t0 = ubDayStart(today); const t1 = ubDayStart(addDays(today, 1));
  const me = actor.id;
  const active: Prisma.OrderWhereInput = { driverId: me, status: { in: ['ASSIGNED', 'OUT_FOR_DELIVERY'] }, OR: [{ deliveryDate: { lte: dateOnly(today) } }, { status: 'OUT_FOR_DELIVERY' }] };
  // Аудит Б2 (B1, #83): «Хүргэсэн / Цуцалсан» ба мөнгө — ӨНӨӨДРИЙН ПАДААНЫ захиалгаар (нягтлангийн «Тооцоо»-той яг ижил).
  // Шөнө 00:00-оос хойш хүргэсэн өчигдрийн падааны захиалга өчигдрийн тооцоонд үлдэнэ.
  const dayIds = (await db.$queryRaw<{ orderId: number }[]>`
    SELECT ho."orderId" FROM "HandoverOrder" ho JOIN "Handover" h ON h.id = ho."handoverId"
    WHERE h."driverId" = ${me}::uuid AND h.date = ${dateOnly(today)}::date AND ho."removedAt" IS NULL`).map((r) => r.orderId);
  const delivered: Prisma.OrderWhereInput = { id: { in: dayIds }, status: 'DELIVERED' };
  const cancelled: Prisma.OrderWhereInput = { id: { in: dayIds }, status: 'CANCELLED' };
  const postponed: Prisma.OrderWhereInput = { postponedByDriverId: me, postponedAt: { gte: t0, lt: t1 } };
  const where: Record<DriverTab, Prisma.OrderWhereInput> = {
    all: { OR: [active, delivered, cancelled, postponed] },
    delivery: active,
    delivered,
    cancelled,
    tomorrow: { OR: [postponed, { driverId: me, status: 'ASSIGNED', deliveryDate: dateOnly(addDays(today, 1)) }] },
    yesterday: { driverId: me, deliveryDate: dateOnly(addDays(today, -1)) },
  };
  const rows = await db.order.findMany({ where: where[tab], include: { lines: { orderBy: { id: 'asc' } } }, take: 300, orderBy: [{ routeNo: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }] });
  const counts = await db.$queryRaw<{ k: string; n: number }[]>`
    SELECT 'delivery' AS k, count(*)::int AS n FROM "Order" WHERE "driverId" = ${me}::uuid AND (status = 'OUT_FOR_DELIVERY' OR (status = 'ASSIGNED' AND "deliveryDate" <= ${dateOnly(today)}::date))
    UNION ALL SELECT 'postponed', count(*)::int FROM "Order" WHERE "postponedByDriverId" = ${me}::uuid AND "postponedAt" >= ${t0} AND "postponedAt" < ${t1}
    UNION ALL SELECT 'tomorrow', count(*)::int FROM "Order" WHERE "driverId" = ${me}::uuid AND status = 'ASSIGNED' AND "deliveryDate" = ${dateOnly(addDays(today, 1))}::date`;
  const c = Object.fromEntries(counts.map((x) => [x.k, x.n])) as Record<string, number>;
  // Тоо ба мөнгө — нягтлангийн тооцоотой нэг томьёо (computeDay)
  const day = (await computeDay(db, today, me))[0];
  const sums = { cash: day?.cash ?? 0, bank: day?.bank ?? 0, unpaid: day?.unpaid ?? 0, prepaid: day?.prepaidAmount ?? 0 };
  c.delivered = day?.delivered ?? 0;
  c.cancelled = (day?.cancelled ?? 0) + (day?.excluded ?? 0);
  return {
    tab, today,
    counts: { delivery: c.delivery ?? 0, delivered: c.delivered ?? 0, cancelled: c.cancelled ?? 0, postponed: c.postponed ?? 0, tomorrow: (c.postponed ?? 0) + (c.tomorrow ?? 0) },
    money: sums,
    items: rows.map((o) => {
      const s = serializeOrder(o);
      const mine = o.driverId === me;
      const postponedByMe = o.postponedByDriverId === me && o.status === 'NEW';
      // Падаанаа хүлээн авахаас өмнө (хуучин шиг): зөвхөн дугаар, утас, хаяг, санамж — бараа, дүн, товч харагдахгүй
      const hidden = o.status === 'ASSIGNED';
      return {
        ...s,
        ...(hidden ? { lines: [], total: 0, subtotal: 0, discount: 0, deliveryFee: 0, originalTotal: null } : {}),
        goodsHidden: hidden,
        fromPrevDay: o.status !== 'DELIVERED' && o.status !== 'CANCELLED' && ymdOf(o.deliveryDate) < today,
        issueLabel: o.issueType ? ISSUE_LABEL[o.issueType] : null,
        paymentLabel: o.deliveryPayment ? PAYMENT_LABEL[o.deliveryPayment] : null,
        can: {
          deliver: mine && o.status === 'OUT_FOR_DELIVERY' && o.issueStatus !== 'PENDING',
          cancel: mine && o.status === 'OUT_FOR_DELIVERY' && o.issueStatus !== 'PENDING',
          postpone: mine && o.status === 'OUT_FOR_DELIVERY' && o.issueStatus !== 'PENDING' && o.postponeCount < MAX_POSTPONE,
          postponeLocked: mine && o.status === 'OUT_FOR_DELIVERY' && o.postponeCount >= MAX_POSTPONE,
          issue: mine && o.status === 'OUT_FOR_DELIVERY' && o.issueStatus !== 'PENDING',
          undoDelivery: mine && o.status === 'DELIVERED',
          redeliver: mine && o.status === 'CANCELLED' && !!o.outForDeliveryAt && ['DRIVER_CANCELLED', 'ISSUE'].includes(o.cancelReason ?? ''),
          undoPostpone: postponedByMe && !o.driverId && !!o.postponedAt && o.postponedAt >= t0,
        },
      };
    }),
  };
}

/** Жолоочийн «#» дараалал (хуучин шиг өөрөө бичнэ) */
export async function setRouteNo(actor: UserActor, idIn: unknown, input: { routeNo?: unknown }) {
  assertDriver(actor);
  const id = cleanId(idIn);
  const v = input.routeNo === null || input.routeNo === '' ? null : Number(input.routeNo);
  if (v !== null && (!Number.isInteger(v) || v < 0 || v > 999)) throw badRequest('Дараалал 0–999');
  const n = await db.order.updateMany({ where: { id, driverId: actor.id }, data: { routeNo: v } });
  if (!n.count) throw notFound('Захиалга олдсонгүй');
  return { routeNo: v };
}

// ───────────────────────── Pickup («Авах») ─────────────────────────

/** Хуваарилаагүй «Шинэ» захиалга (өнөөдөр, маргааш) — жолооч өөрөө авна (хуучин шиг) */
export async function pickupList(actor: UserActor, p: { page?: number; district?: string }) {
  assertDriver(actor);
  const page = Math.max(1, Math.min(200, Math.floor(p.page ?? 1)));
  const where: Prisma.OrderWhereInput = { status: 'NEW', driverId: null, deliveryDate: { lte: dateOnly(ubDay(new Date(), 1)) }, ...(p.district ? { district: p.district } : {}) };
  const rows = await db.order.findMany({ where, orderBy: [{ deliveryDate: 'asc' }, { id: 'asc' }], skip: (page - 1) * 50, take: 51, include: { lines: true } });
  // Падаанаа хүлээн авахаас өмнөх карт шиг: зөвхөн дугаар, огноо, хаяг, санамж — бараа, дүн, утас харагдахгүй (#77)
  return {
    page, hasMore: rows.length > 50,
    items: rows.slice(0, 50).map((o) => {
      const s = serializeOrder(o);
      return { id: s.id, number: s.number, deliveryDate: s.deliveryDate, fullAddress: s.fullAddress, district: s.district, note: s.note, postponeCount: s.postponeCount };
    }),
  };
}

export async function pickUp(actor: UserActor, input: { ids?: unknown }) {
  assertDriver(actor);
  const ids = Array.isArray(input.ids) ? [...new Set((input.ids as unknown[]).map(Number))].filter((n) => Number.isInteger(n) && n > 0).slice(0, 50) : [];
  if (!ids.length) throw badRequest('Захиалга сонгоно уу');
  return assignCore(actor, ids, { id: actor.id, name: actor.name }, { pickup: true });
}

// ───────────────────────── Өрийн дэвтэр (жолоочийн хувийн, #79) ─────────────────────────

/** Жолоочийн «Өрийн дэвтэр»: «Төлөөгүй» гэж хүргэсэн захиалгууд — нийт өр, мөр бүр (утас, хаяг, бараа, дүн) */
export async function myDebts(actor: UserActor, p: { paid?: boolean } = {}) {
  assertDriver(actor);
  const where: Prisma.DriverDebtWhereInput = { driverId: actor.id, cancelledAt: null, paidAt: p.paid ? { not: null } : null };
  const [rows, sum] = await Promise.all([
    db.driverDebt.findMany({ where, orderBy: p.paid ? { paidAt: 'desc' } : { createdAt: 'desc' }, take: 200 }),
    db.driverDebt.aggregate({ where: { driverId: actor.id, cancelledAt: null, paidAt: null }, _sum: { amount: true }, _count: true }),
  ]);
  const orders = await db.order.findMany({ where: { id: { in: rows.map((r) => r.orderId) } }, include: { lines: { orderBy: { id: 'asc' } } } });
  const om = new Map(orders.map((o) => [o.id, serializeOrder(o)]));
  return {
    summary: { amount: sum._sum.amount ?? 0, count: sum._count },
    items: rows.map((d) => {
      const o = om.get(d.orderId);
      return { id: d.id, orderId: d.orderId, number: d.orderNumber, phone: d.phone, amount: d.amount, createdAt: d.createdAt, paidAt: d.paidAt,
        fullAddress: o?.fullAddress ?? '', extraPhone: o?.extraPhone ?? null, lines: (o?.lines ?? []).filter((l) => l.qty > l.refusedQty).map((l) => ({ id: l.id, name: l.name, label: l.label, code: l.code, thumb: l.thumb, qty: l.qty - l.refusedQty, unitPrice: l.unitPrice })) };
    }),
  };
}

/** «Төлсөн» — үйлчлүүлэгч мөнгөө өгсөн (зөвхөн өөрийн мөр; давхар дарахад нэг удаа) */
export async function markDebtPaid(actor: UserActor, idIn: unknown) {
  assertDriver(actor);
  const id = Number(idIn);
  if (!Number.isInteger(id) || id <= 0) throw notFound('Өр олдсонгүй');
  const d = await db.driverDebt.findUnique({ where: { id } });
  if (!d || d.driverId !== actor.id || d.cancelledAt) throw notFound('Өр олдсонгүй');
  if (d.paidAt) return { debt: d, duplicate: true };
  const n = await db.driverDebt.updateMany({ where: { id, paidAt: null }, data: { paidAt: new Date() } });
  if (n.count) await writeAudit(actor, 'driver.debt_paid', 'Order', String(d.orderId), { number: d.orderNumber, amount: d.amount, phone: d.phone }, db, ['delivery']);
  return { debt: await db.driverDebt.findUniqueOrThrow({ where: { id } }), duplicate: n.count === 0 };
}

export { cleanId as cleanOrderId };
