import type { Prisma } from '@prisma/client';
import { db } from '../../db';
import { badRequest, conflict, forbidden, notFound } from '../../errors';
import { writeAudit } from '../../audit';
import { canApproveDrivers, canOperateHandover, canView } from '../../permissions';
import { mediaUrl } from '../../storage';
import { dateOnly, ubDay, ymdOf, isYmd } from '../../ubdate';
import { applyMoves, stockCache, type MoveSpec } from '../stock/core';
import { inTx, type UserActor } from '../orders/core';
import { bustCounts } from '../orders/queries';
import { HANDOVER_STATUS_LABEL, approvalFor, cleanYmd, driverLocationId, lockDelivery, lockHandover, lockOrders, nextHandoverNumber, primaryWarehouse } from './core';

/**
 * Жолоочид бараа өгөх — хуучин ERP-ийн урсгал (#66): агуулах жолооч + огноо сонгоод захиалгуудаа (бүгдийг) сонгож «Падаан үүсгэх»,
 * бараа бүрийг Check (заавал, #65) → «Бэлтгэсэн» → «Барааг бүрэн өгсөн».
 * «Барааг бүрэн өгсөн»: бараа ҮНДСЭН АГУУЛАХААС ЖОЛООЧИЙН ГАРТ журналаар шилжинэ (HANDOVER), захиалгын нөөц суллагдана,
 * захиалгууд «Хүргэлтэд гарсан». Ингэснээр хуучин ERP-ийн «буцаалт давхар нэмэгддэг» алдаа гарахгүй (дүрэм B2).
 */
const assertView = (a: UserActor) => { if (!canView(a.roles, 'handover')) throw forbidden(); };
const assertOperate = (a: UserActor) => { if (!canOperateHandover(a.roles)) throw forbidden('Падааныг агуулахын ажилтан, админ хийнэ'); };

function cleanUuid(v: unknown, label = 'Жолооч'): string {
  const s = String(v ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(s)) throw badRequest(`${label} буруу`);
  return s;
}

/** Жолооч сонгох жагсаалт: OKEY/ХОРИГ, захиалгын тоо, төлөв (Бэлдээгүй / Бэлдэж байна / Бэлдсэн / Өгсөн) */
export async function handoverBoard(actor: UserActor, dateInput?: string) {
  assertView(actor);
  const date = dateInput && isYmd(dateInput) ? dateInput : ubDay();
  const d = dateOnly(date);
  const [drivers, counts, handovers, approvals, settings] = await Promise.all([
    db.user.findMany({ where: { isActive: true, roles: { has: 'DRIVER' } }, orderBy: { name: 'asc' }, select: { id: true, name: true, phone: true } }),
    db.$queryRaw<{ driverId: string; n: number }[]>`SELECT "driverId", count(*)::int AS n FROM "Order" WHERE "driverId" IS NOT NULL AND "deliveryDate" = ${d}::date AND status IN ('ASSIGNED','OUT_FOR_DELIVERY') GROUP BY 1`,
    db.handover.findMany({ where: { date: d }, select: { id: true, number: true, driverId: true, status: true } }),
    db.driverApproval.findMany({ where: { date: d } }),
    db.driverSetting.findMany({ where: { trusted: true } }),
  ]);
  const cm = new Map(counts.map((c) => [c.driverId, c.n]));
  const hm = new Map(handovers.map((h) => [h.driverId, h]));
  const am = new Map(approvals.map((a) => [a.driverId, a]));
  const trusted = new Set(settings.map((s) => s.userId));
  return {
    date, canOperate: canOperateHandover(actor.roles), canApprove: canApproveDrivers(actor.roles),
    drivers: drivers.map((dr) => {
      const h = hm.get(dr.id);
      const a = am.get(dr.id);
      const approved = a ? a.approved : trusted.has(dr.id);
      const orders = cm.get(dr.id) ?? 0;
      return {
        ...dr, orders, trusted: trusted.has(dr.id), approved, approvalNote: a?.note ?? null, approvalBy: a?.byName ?? (trusted.has(dr.id) ? 'Итгэлтэй (автомат)' : null),
        handover: h ? { id: h.id, number: h.number, status: h.status } : null,
        stateLabel: h ? (h.status === 'DRAFT' ? 'Бэлдэж байна' : h.status === 'PREPARED' ? 'Бэлдсэн' : 'Өгсөн') : orders ? 'Бэлдээгүй' : '—',
      };
    }),
  };
}

/** Жолоочийн тухайн өдөр: падаан байвал түүнийг, үгүй бол падаанд оруулах захиалгууд */
export async function driverDay(actor: UserActor, input: { driverId?: unknown; date?: unknown }) {
  assertView(actor);
  const driverId = cleanUuid(input.driverId);
  const date = cleanYmd(input.date);
  const h = await db.handover.findUnique({ where: { driverId_date: { driverId, date: dateOnly(date) } }, select: { id: true } });
  if (h) return { handover: await handoverDetail(actor, h.id), eligible: [], approval: await approvalFor(db, driverId, date) };
  const rows = await db.order.findMany({
    where: { driverId, deliveryDate: dateOnly(date), status: 'ASSIGNED', handoverId: null },
    orderBy: { id: 'asc' }, include: { lines: { select: { qty: true } } },
  });
  return {
    handover: null, approval: await approvalFor(db, driverId, date),
    eligible: rows.map((o) => ({ id: o.id, number: o.number, phone: o.phone, items: o.lines.reduce((a, l) => a + l.qty, 0), total: o.total, note: o.note })),
  };
}

/** Падааны дэлгэрэнгүй: бараа нэгтгэсэн (тавиурын дарааллаар) + Check, захиалгууд (хасагдсан нь улаанаар) */
export async function handoverDetail(actor: UserActor, idInput: unknown) {
  assertView(actor);
  const id = Number(idInput);
  const h = await db.handover.findUnique({ where: { id }, include: { orders: { orderBy: { position: 'asc' } }, checks: true } });
  if (!h) throw notFound('Падаан олдсонгүй');
  const orderIds = h.orders.map((x) => x.orderId);
  const orders = await db.order.findMany({ where: { id: { in: orderIds } }, include: { lines: true } });
  const om = new Map(orders.map((o) => [o.id, o]));
  const active = h.orders.filter((x) => !x.removedAt).map((x) => ({ ho: x, o: om.get(x.orderId)! })).filter((x) => x.o);
  const agg = new Map<number, { variantId: number; productId: number; code: string; name: string; label: string; imageKey: string | null; qty: number; amount: number }>();
  for (const { o } of active) for (const l of o.lines) {
    const e = agg.get(l.variantId) ?? { variantId: l.variantId, productId: l.productId, code: l.code, name: l.name, label: l.label, imageKey: l.imageKey, qty: 0, amount: 0 };
    e.qty += l.qty; e.amount += l.qty * l.unitPrice;
    agg.set(l.variantId, e);
  }
  const products = await db.product.findMany({ where: { id: { in: [...new Set([...agg.values()].map((x) => x.productId))] } }, select: { id: true, shelfCode: true } });
  const shelf = new Map(products.map((p) => [p.id, p.shelfCode]));
  const checked = new Map(h.checks.map((c) => [c.variantId, c]));
  const items = [...agg.values()].map((x) => ({
    variantId: x.variantId, code: x.code, name: x.name, label: x.label, qty: x.qty, amount: x.amount,
    thumb: x.imageKey ? mediaUrl(x.imageKey, 'sm') : null, image: x.imageKey ? mediaUrl(x.imageKey, 'lg') : null,
    shelfCode: shelf.get(x.productId) ?? null, checked: checked.has(x.variantId), checkedBy: checked.get(x.variantId)?.checkedBy ?? null,
  })).sort((a, b) => (a.shelfCode ?? '~').localeCompare(b.shelfCode ?? '~', 'mn') || a.name.localeCompare(b.name, 'mn') || a.code.localeCompare(b.code));
  return {
    id: h.id, number: h.number, date: ymdOf(h.date), driverId: h.driverId, driverName: h.driverName, status: h.status, statusLabel: HANDOVER_STATUS_LABEL[h.status],
    version: h.version, createdAt: h.createdAt, createdByName: h.createdByName, preparedAt: h.preparedAt, preparedBy: h.preparedBy, handedOverAt: h.handedOverAt, handedOverBy: h.handedOverBy,
    canOperate: canOperateHandover(actor.roles),
    totals: { orders: active.length, pieces: items.reduce((a, x) => a + x.qty, 0), amount: active.reduce((a, x) => a + x.o.total, 0), checked: items.filter((x) => x.checked).length, kinds: items.length },
    items,
    orders: h.orders.map((x) => {
      const o = om.get(x.orderId);
      return {
        orderId: x.orderId, position: x.position, number: o?.number ?? '?', phone: o?.phone ?? '', total: o?.total ?? 0, createdAt: o?.createdAt ?? null, status: o?.status ?? null,
        note: o?.note ?? null, isNew: x.addedAt.getTime() > h.createdAt.getTime(), removedAt: x.removedAt, removeReason: x.removeReason,
        lines: (o?.lines ?? []).map((l) => ({ name: l.name, label: l.label, code: l.code, qty: l.qty, unitPrice: l.unitPrice })),
      };
    }),
  };
}

/** Падаан үүсгэх — тэр жолоочийн тэр өдрийн БҮХ захиалгыг сонгосон байх ёстой (хуучин шиг), нягтлангийн OKEY заавал (#65) */
export async function createHandover(actor: UserActor, input: { driverId?: unknown; date?: unknown; orderIds?: unknown }) {
  assertOperate(actor);
  const driverId = cleanUuid(input.driverId);
  const date = cleanYmd(input.date);
  const orderIds = Array.isArray(input.orderIds) ? [...new Set((input.orderIds as unknown[]).map(Number))].filter((n) => Number.isInteger(n) && n > 0) : [];
  if (!orderIds.length) throw badRequest('Захиалга сонгоно уу');
  const driver = await db.user.findUnique({ where: { id: driverId }, select: { id: true, name: true, roles: true } });
  if (!driver || !driver.roles.includes('DRIVER')) throw badRequest('Жолооч олдсонгүй');
  const res = await inTx(async (tx) => {
    await lockDelivery(tx);
    const ap = await approvalFor(tx, driverId, date);
    if (!ap.approved) throw conflict(`Нягтлан зөвшөөрөл өгөөгүй (ХОРИГ)${ap.note ? `: ${ap.note}` : ''}. Нягтлантай холбогдоно уу.`, 'not_approved');
    const exists = await tx.handover.findUnique({ where: { driverId_date: { driverId, date: dateOnly(date) } } });
    if (exists) throw conflict(`${driver.name}-д ${date}-ны падаан (${exists.number}) аль хэдийн байна`, 'handover_exists');
    const eligible = await tx.order.findMany({ where: { driverId, deliveryDate: dateOnly(date), status: 'ASSIGNED', handoverId: null }, select: { id: true } });
    const eSet = new Set(eligible.map((o) => o.id));
    const foreign = orderIds.filter((x) => !eSet.has(x));
    if (foreign.length) throw conflict('Сонгосон захиалгын зарим нь энэ жолоочийн энэ өдрийн биш эсвэл өөрчлөгдсөн байна. Дахин ачаална уу.', 'stale');
    const missing = eligible.length - orderIds.length;
    if (missing > 0) throw badRequest(`Анхаар! ${missing} захиалга сонгоогүй байна — жолоочийн бүх захиалгыг сонгоно уу`, 'not_all_selected');
    await lockOrders(tx, orderIds);
    const { warehouse } = await primaryWarehouse(tx);
    const h = await tx.handover.create({ data: { number: await nextHandoverNumber(tx), date: dateOnly(date), driverId, driverName: driver.name, warehouseId: warehouse.id, createdById: actor.id, createdByName: actor.name } });
    await tx.handoverOrder.createMany({ data: orderIds.sort((a, b) => a - b).map((orderId, i) => ({ handoverId: h.id, orderId, position: i + 1, addedAt: h.createdAt })) });
    await tx.order.updateMany({ where: { id: { in: orderIds } }, data: { handoverId: h.id } });
    await writeAudit(actor, 'handover.created', 'Handover', String(h.id), { number: h.number, driver: driver.name, date, orders: orderIds.length }, tx, ['delivery']);
    return h;
  });
  bustCounts();
  return handoverDetail(actor, res.id);
}

async function loadForChange(tx: Prisma.TransactionClient, id: number) {
  if (!(await lockHandover(tx, id))) throw notFound('Падаан олдсонгүй');
  return tx.handover.findUniqueOrThrow({ where: { id } });
}

/** Бараа бүрийн Check (агуулах) */
export async function setCheck(actor: UserActor, idInput: unknown, input: { variantId?: unknown; checked?: unknown }) {
  assertOperate(actor);
  const id = Number(idInput);
  const variantId = Number(input.variantId);
  if (!Number.isInteger(variantId)) throw badRequest('Бараа буруу');
  await inTx(async (tx) => {
    const h = await loadForChange(tx, id);
    if (h.status === 'HANDED_OVER') throw conflict('Бараа өгөгдсөн падаан', 'handed_over');
    const inSheet = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "HandoverOrder" ho JOIN "OrderLine" l ON l."orderId" = ho."orderId"
      WHERE ho."handoverId" = ${id} AND ho."removedAt" IS NULL AND l."variantId" = ${variantId}`;
    if (!inSheet[0]?.n) throw badRequest('Энэ бараа падаанд алга');
    if (input.checked === false) await tx.handoverCheck.deleteMany({ where: { handoverId: id, variantId } });
    else await tx.handoverCheck.upsert({ where: { handoverId_variantId: { handoverId: id, variantId } }, create: { handoverId: id, variantId, checkedBy: actor.name }, update: {} });
  });
  return { ok: true };
}

/** «Бэлтгэсэн» (Ноорог → Бэлтгэсэн) */
export async function prepareHandover(actor: UserActor, idInput: unknown) {
  assertOperate(actor);
  const id = Number(idInput);
  await inTx(async (tx) => {
    const h = await loadForChange(tx, id);
    if (h.status !== 'DRAFT') return;
    await tx.handover.update({ where: { id }, data: { status: 'PREPARED', preparedAt: new Date(), preparedBy: actor.name, version: { increment: 1 } } });
    await writeAudit(actor, 'handover.prepared', 'Handover', String(id), { number: h.number }, tx, ['delivery']);
  });
  return handoverDetail(actor, id);
}

/**
 * «Барааг бүрэн өгсөн» — бүх бараа Check хийгдсэн байх ёстой (#65).
 * Бараа үндсэн агуулахаас жолоочийн гарт шилжинэ (журнал), нөөц суллагдана, захиалгууд «Хүргэлтэд гарсан».
 * Зэрэг дарахад нэг л удаа (падааны мөрийн түгжээ + төлөв шалгалт).
 */
export async function confirmHandover(actor: UserActor, idInput: unknown) {
  assertOperate(actor);
  const id = Number(idInput);
  let duplicate = false;
  await inTx(async (tx) => {
    await lockDelivery(tx);
    const h = await loadForChange(tx, id);
    if (h.status === 'HANDED_OVER') { duplicate = true; return; }
    if (h.status !== 'PREPARED') throw conflict('Эхлээд «Бэлтгэсэн» дарна уу', 'not_prepared');
    const hos = await tx.handoverOrder.findMany({ where: { handoverId: id, removedAt: null }, select: { orderId: true } });
    if (!hos.length) throw badRequest('Падаанд захиалга алга');
    const orderIds = hos.map((x) => x.orderId);
    await lockOrders(tx, orderIds);
    const orders = await tx.order.findMany({ where: { id: { in: orderIds } }, include: { lines: true } });
    const bad = orders.find((o) => o.status !== 'ASSIGNED' || o.driverId !== h.driverId);
    if (bad) throw conflict(`№${bad.number} захиалга өөрчлөгдсөн байна — дахин ачаална уу`, 'stale');
    const qty = new Map<number, number>();
    for (const o of orders) for (const l of o.lines) qty.set(l.variantId, (qty.get(l.variantId) ?? 0) + l.qty);
    const checks = new Set((await tx.handoverCheck.findMany({ where: { handoverId: id }, select: { variantId: true } })).map((c) => c.variantId));
    const unchecked = [...qty.keys()].filter((v) => !checks.has(v));
    if (unchecked.length) throw conflict(`${unchecked.length} бараа Check хийгдээгүй байна — бүх барааг шалгана уу`, 'not_checked');
    const wh = await tx.warehouse.findUnique({ where: { id: h.warehouseId }, include: { location: true } });
    if (!wh?.location) throw badRequest('Агуулах олдсонгүй');
    const toId = await driverLocationId(tx, { id: h.driverId, name: h.driverName });
    const moves: MoveSpec[] = [...qty.entries()].map(([variantId, q]) => ({ type: 'HANDOVER', variantId, qty: q, fromId: wh.location!.id, toId, note: `${h.number} · ${h.driverName}` }));
    await applyMoves(tx, actor, { type: 'handover', id }, moves);
    await tx.stockReservation.deleteMany({ where: { orderId: { in: orderIds } } });
    const now = new Date();
    await tx.order.updateMany({ where: { id: { in: orderIds } }, data: { status: 'OUT_FOR_DELIVERY', outForDeliveryAt: now, version: { increment: 1 } } });
    await tx.handover.update({ where: { id }, data: { status: 'HANDED_OVER', handedOverAt: now, handedOverBy: actor.name, version: { increment: 1 } } });
    await writeAudit(actor, 'handover.handed_over', 'Handover', String(id), {
      number: h.number, driver: h.driverName, orders: orderIds.length, pieces: [...qty.values()].reduce((a, b) => a + b, 0), from: wh.name,
    }, tx, ['delivery', 'stock']);
  });
  stockCache.today = null; bustCounts();
  return { ...(await handoverDetail(actor, id)), duplicate };
}

/**
 * «Буцаах»: Бэлтгэсэн → Ноорог (Check арилна); Өгсөн → Ноорог — бараа жолоочоос агуулахад буцаж (журнал),
 * нөөц сэргэж, захиалгууд «Жолоочид оноосон» болно (жолооч хүргэж эхлээгүй үед л — Модуль 5).
 */
export async function revertHandover(actor: UserActor, idInput: unknown) {
  assertOperate(actor);
  const id = Number(idInput);
  await inTx(async (tx) => {
    await lockDelivery(tx);
    const h = await loadForChange(tx, id);
    if (h.status === 'DRAFT') return;
    if (h.status === 'HANDED_OVER') {
      const hos = await tx.handoverOrder.findMany({ where: { handoverId: id, removedAt: null }, select: { orderId: true } });
      const orderIds = hos.map((x) => x.orderId);
      await lockOrders(tx, orderIds);
      const orders = await tx.order.findMany({ where: { id: { in: orderIds } }, include: { lines: true } });
      const moved = orders.find((o) => o.status !== 'OUT_FOR_DELIVERY');
      if (moved) throw conflict(`№${moved.number} захиалгыг жолооч аль хэдийн хүргэсэн/цуцалсан тул буцаах боломжгүй`, 'driver_started');
      const qty = new Map<number, number>();
      for (const o of orders) for (const l of o.lines) qty.set(l.variantId, (qty.get(l.variantId) ?? 0) + l.qty);
      const wh = await tx.warehouse.findUnique({ where: { id: h.warehouseId }, include: { location: true } });
      const fromId = await driverLocationId(tx, { id: h.driverId, name: h.driverName });
      await applyMoves(tx, actor, { type: 'handover', id }, [...qty.entries()].map(([variantId, q]) => ({ type: 'HANDOVER_BACK' as const, variantId, qty: q, fromId, toId: wh!.location!.id, note: `${h.number} буцаасан` })));
      for (const o of orders) await tx.stockReservation.createMany({ data: o.lines.map((l) => ({ ref: `order:${o.id}`, orderId: o.id, variantId: l.variantId, qty: l.qty })) });
      await tx.order.updateMany({ where: { id: { in: orderIds } }, data: { status: 'ASSIGNED', outForDeliveryAt: null, version: { increment: 1 } } });
    }
    await tx.handoverCheck.deleteMany({ where: { handoverId: id } });
    await tx.handover.update({ where: { id }, data: { status: 'DRAFT', preparedAt: null, preparedBy: null, handedOverAt: null, handedOverBy: null, version: { increment: 1 } } });
    await writeAudit(actor, 'handover.reverted', 'Handover', String(id), { number: h.number, from: h.status }, tx, h.status === 'HANDED_OVER' ? ['delivery', 'stock'] : ['delivery']);
  });
  stockCache.today = null; bustCounts();
  return handoverDetail(actor, id);
}

/** «Падаан буцаах» (зөвхөн Ноорог): падаан устаж, захиалгууд жолоочид оноосон хэвээр үлдэнэ */
export async function deleteHandover(actor: UserActor, idInput: unknown) {
  assertOperate(actor);
  const id = Number(idInput);
  await inTx(async (tx) => {
    await lockDelivery(tx);
    const h = await loadForChange(tx, id);
    if (h.status !== 'DRAFT') throw conflict('Эхлээд «Буцаах» дарж ноорог болгоно уу', 'not_draft');
    await tx.order.updateMany({ where: { handoverId: id }, data: { handoverId: null } });
    await tx.handover.delete({ where: { id } });
    await writeAudit(actor, 'handover.deleted', 'Handover', String(id), { number: h.number, driver: h.driverName, date: ymdOf(h.date) }, tx, ['delivery']);
  });
  bustCounts();
  return { deleted: true };
}

/** Падааны түүх (огноо, жолоочоор), 100 хүртэл */
export async function handoverHistory(actor: UserActor, p: { from?: string; to?: string; driverId?: string }) {
  assertView(actor);
  const to = p.to && isYmd(p.to) ? p.to : ubDay();
  const from = p.from && isYmd(p.from) ? p.from : ubDay(new Date(), -7);
  const rows = await db.handover.findMany({
    where: { date: { gte: dateOnly(from), lte: dateOnly(to) }, ...(p.driverId ? { driverId: cleanUuid(p.driverId) } : {}) },
    orderBy: [{ date: 'desc' }, { id: 'desc' }], take: 100, include: { _count: { select: { orders: { where: { removedAt: null } } } } },
  });
  return {
    from, to,
    items: rows.map((h) => ({
      id: h.id, number: h.number, date: ymdOf(h.date), driverName: h.driverName, status: h.status, statusLabel: HANDOVER_STATUS_LABEL[h.status], orders: h._count.orders,
      createdByName: h.createdByName, createdAt: h.createdAt, handedOverBy: h.handedOverBy, handedOverAt: h.handedOverAt,
    })),
  };
}

// ───────────────────────── Нягтлангийн OKEY / ХОРИГ ─────────────────────────

export async function setApproval(actor: UserActor, input: { driverId?: unknown; date?: unknown; approved?: unknown; note?: unknown }) {
  if (!canApproveDrivers(actor.roles)) throw forbidden('OKEY / ХОРИГ-ийг нягтлан, админ тавина');
  const driverId = cleanUuid(input.driverId);
  const date = cleanYmd(input.date);
  const approved = input.approved === true;
  const note = String(input.note ?? '').trim().slice(0, 200) || null;
  if (!approved && !note) throw badRequest('ХОРИГ-ийн шалтгааныг бичнэ үү (жишээ: өр 120,000₮)', 'reason_required');
  await db.$transaction(async (tx) => {
    await tx.driverApproval.upsert({ where: { driverId_date: { driverId, date: dateOnly(date) } }, create: { driverId, date: dateOnly(date), approved, note, byName: actor.name }, update: { approved, note, byName: actor.name, at: new Date() } });
    await writeAudit(actor, approved ? 'driver.approved' : 'driver.blocked', 'User', driverId, { date, note }, tx, ['delivery', 'money']);
  });
  return approvalFor(db, driverId, date);
}

export async function setTrusted(actor: UserActor, input: { driverId?: unknown; trusted?: unknown }) {
  if (!canApproveDrivers(actor.roles)) throw forbidden('Нягтлан, админ тохируулна');
  const driverId = cleanUuid(input.driverId);
  const trusted = input.trusted === true;
  await db.$transaction(async (tx) => {
    await tx.driverSetting.upsert({ where: { userId: driverId }, create: { userId: driverId, trusted, updatedBy: actor.name }, update: { trusted, updatedBy: actor.name } });
    await writeAudit(actor, 'driver.trusted', 'User', driverId, { trusted }, tx, ['delivery']);
  });
  return { trusted };
}

/** Падаан эхлүүлэхээс өмнө: үндсэн агуулахад хүрэлцэх эсэх (дутуу бол «Дүүргэлт»-ээр татна) */
export async function shortages(actor: UserActor, idInput: unknown) {
  assertView(actor);
  const d = await handoverDetail(actor, idInput);
  const h = await db.handover.findUniqueOrThrow({ where: { id: d.id } });
  const wh = await primaryWarehouse(db).catch(() => null);
  const locId = wh && wh.warehouse.id === h.warehouseId ? wh.locationId : (await db.stockLocation.findUnique({ where: { warehouseId: h.warehouseId } }))?.id;
  const bal = await db.stockBalance.findMany({ where: { locationId: locId ?? -1, variantId: { in: d.items.map((i) => i.variantId) } } });
  const bm = new Map(bal.map((b) => [b.variantId, b.qty]));
  return d.items.filter((i) => (bm.get(i.variantId) ?? 0) < i.qty).map((i) => ({ variantId: i.variantId, code: i.code, name: i.name, need: i.qty, have: bm.get(i.variantId) ?? 0 }));
}
