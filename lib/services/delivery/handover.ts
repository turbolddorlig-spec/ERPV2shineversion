import type { Prisma } from '@prisma/client';
import { db } from '../../db';
import { badRequest, conflict, forbidden, notFound } from '../../errors';
import { writeAudit } from '../../audit';
import { canApproveDrivers, canDrive, canOperateHandover, canView } from '../../permissions';
import { mediaUrl } from '../../storage';
import { variantInfo } from '../stock/info';
import { driverGoods } from './driver';
import { dateOnly, ubDay, ymdOf, isYmd } from '../../ubdate';
import { addDays as addDaysYmd } from './core';
import { applyMoves, handedOverNeed, stockCache, type MoveSpec } from '../stock/core';
import { inTx, type UserActor } from '../orders/core';
import { bustCounts } from '../orders/queries';
import { assertDayOpen } from '../accounting/lock';
import { HANDOVER_STATUS_LABEL, isGiven, approvalFor, cleanYmd, driverLocationId, lockDrivers, lockHandover, lockOrders, nextHandoverNumber, primaryWarehouse } from './core';

/**
 * Жолоочид бараа өгөх — хуучин ERP-ийн урсгал (#66): агуулах жолооч + огноо сонгоод захиалгуудаа (бүгдийг) сонгож «Падаан үүсгэх»,
 * бараа бүрийг Check (заавал, #65) → «Бэлтгэсэн» → «Барааг бүрэн өгсөн».
 * «Барааг бүрэн өгсөн»: бараа ҮНДСЭН АГУУЛАХААС ЖОЛООЧИЙН ГАРТ журналаар шилжинэ (HANDOVER), захиалгын нөөц суллагдана,
 * захиалгууд «Хүргэлтэд гарсан». Ингэснээр хуучин ERP-ийн «буцаалт давхар нэмэгддэг» алдаа гарахгүй (дүрэм B2).
 */
const assertView = (a: UserActor) => { if (!canView(a.roles, 'handover')) throw forbidden(); };
const assertOperate = (a: UserActor) => { if (!canOperateHandover(a.roles)) throw forbidden('Падааныг агуулахын ажилтан, админ хийнэ'); };

/** Аудит #147: падааны дугаар (id) буруу бол 404 — системийн алдаа биш */
function cleanHid(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 2_147_483_647) throw notFound('Падаан олдсонгүй');
  return n;
}
/** Падааны жолоочийн түгжээ (жолооч бүрээр, #147) */
async function lockHandoverDriver(tx: Prisma.TransactionClient, id: number) {
  const pre = await tx.handover.findUnique({ where: { id }, select: { driverId: true } });
  if (!pre) throw notFound('Падаан олдсонгүй');
  await lockDrivers(tx, [pre.driverId]);
}

function cleanUuid(v: unknown, label = 'Жолооч'): string {
  const s = String(v ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(s)) throw badRequest(`${label} буруу`);
  return s;
}

/**
 * Аудит #147 (эзний шийдвэр): агуулах өгсөн боловч жолооч 2 цагаас удаан хүлээн аваагүй падаан — бараа жолоочийн гарт,
 * захиалга хүргэлтэд гараагүй. Агуулах, ахлах жолооч, Супер админд улаанаар.
 */
export const STALE_HANDED_OVER_MS = 2 * 3600_000;
export async function staleHandedOver() {
  const rows = await db.handover.findMany({ where: { status: 'HANDED_OVER', handedOverAt: { lt: new Date(Date.now() - STALE_HANDED_OVER_MS) } }, orderBy: { handedOverAt: 'asc' }, take: 50,
    select: { id: true, number: true, date: true, driverId: true, driverName: true, handedOverAt: true, handedOverBy: true } });
  return rows.map((r) => ({ ...r, date: ymdOf(r.date) }));
}

let staleCache: { at: number; n: number } | null = null;
export async function staleHandoverAlert(roles: string[]): Promise<{ count: number } | null> {
  if (!roles.some((r) => ['SUPER_ADMIN', 'ADMIN', 'DRIVER_LEAD', 'WAREHOUSE'].includes(r))) return null;
  if (!staleCache || Date.now() - staleCache.at > 30_000) {
    staleCache = { at: Date.now(), n: await db.handover.count({ where: { status: 'HANDED_OVER', handedOverAt: { lt: new Date(Date.now() - STALE_HANDED_OVER_MS) } } }) };
  }
  return staleCache.n ? { count: staleCache.n } : null;
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
    date, canOperate: canOperateHandover(actor.roles), canApprove: canApproveDrivers(actor.roles), staleHandedOver: await staleHandedOver(),
    drivers: drivers.map((dr) => {
      const h = hm.get(dr.id);
      const a = am.get(dr.id);
      const approved = a ? a.approved : trusted.has(dr.id);
      const orders = cm.get(dr.id) ?? 0;
      return {
        ...dr, orders, trusted: trusted.has(dr.id), approved, approvalNote: a?.note ?? null, approvalBy: a?.byName ?? (trusted.has(dr.id) ? 'Итгэлтэй (автомат)' : null),
        handover: h ? { id: h.id, number: h.number, status: h.status } : null,
        stateLabel: h ? HANDOVER_STATUS_LABEL[h.status] : orders ? 'Бэлдээгүй' : '—',
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
  if (h) {
    const hd = await handoverDetail(actor, h.id);
    return { handover: hd, shortages: await shortages(actor, h.id, hd), eligible: [], approval: await approvalFor(db, driverId, date) };
  }
  const rows = await db.order.findMany({
    where: { driverId, deliveryDate: dateOnly(date), status: 'ASSIGNED', handoverId: null },
    orderBy: { id: 'asc' }, include: { lines: { select: { qty: true } } },
  });
  return {
    handover: null, shortages: [], approval: await approvalFor(db, driverId, date),
    eligible: rows.map((o) => ({ id: o.id, number: o.number, phone: o.phone, items: o.lines.reduce((a, l) => a + l.qty, 0), total: o.total, note: o.note })),
  };
}

/** Падааны дэлгэрэнгүй: бараа нэгтгэсэн (тавиурын дарааллаар) + Check, захиалгууд (хасагдсан нь улаанаар) */
export async function handoverDetail(actor: UserActor, idInput: unknown) {
  assertView(actor);
  return buildDetail(cleanHid(idInput), canOperateHandover(actor.roles));
}

async function buildDetail(id: number, canOperate: boolean) {
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
  const checked = new Map(h.checks.filter((c) => c.kind === 'ORDER').map((c) => [c.variantId, c]));
  const xChecked = new Map(h.checks.filter((c) => c.kind === 'EXTRA').map((c) => [c.variantId, c]));
  // Жолоочийн нэмэлт барааны хүсэлт (#80) — падаанд тусдаа
  const xdocs = await db.driverDoc.findMany({ where: { handoverId: id, kind: 'EXTRA_TAKE', status: { in: ['REQUESTED', 'GIVEN'] } }, include: { lines: true }, orderBy: { id: 'asc' } });
  const xqty = new Map<number, number>();
  for (const d of xdocs) for (const l of d.lines) xqty.set(l.variantId, (xqty.get(l.variantId) ?? 0) + l.qty);
  const xinfo = await variantInfo([...xqty.keys()]);
  const xprice = new Map((await db.productVariant.findMany({ where: { id: { in: [...xqty.keys()] } }, select: { id: true, priceOverride: true, product: { select: { price: true } } } })).map((v) => [v.id, v.priceOverride ?? v.product.price]));
  const extras = [...xqty].map(([variantId, qty]) => {
    const i = xinfo.get(variantId);
    return { variantId, code: i?.code ?? '', name: i?.name ?? `#${variantId}`, label: i?.label ?? '', qty, amount: qty * (xprice.get(variantId) ?? 0), thumb: i?.thumb ?? null, image: null as string | null, shelfCode: i?.shelfCode ?? null,
      checked: xChecked.has(variantId), checkedBy: xChecked.get(variantId)?.checkedBy ?? null, driverChecked: !!xChecked.get(variantId)?.driverCheckedAt };
  }).sort((a, b) => (a.shelfCode ?? '~').localeCompare(b.shelfCode ?? '~', 'mn') || a.code.localeCompare(b.code));
  const items = [...agg.values()].map((x) => ({
    variantId: x.variantId, code: x.code, name: x.name, label: x.label, qty: x.qty, amount: x.amount,
    thumb: x.imageKey ? mediaUrl(x.imageKey, 'sm') : null, image: x.imageKey ? mediaUrl(x.imageKey, 'lg') : null,
    shelfCode: shelf.get(x.productId) ?? null, checked: checked.has(x.variantId), checkedBy: checked.get(x.variantId)?.checkedBy ?? null,
    driverChecked: !!checked.get(x.variantId)?.driverCheckedAt,
  })).sort((a, b) => (a.shelfCode ?? '~').localeCompare(b.shelfCode ?? '~', 'mn') || a.name.localeCompare(b.name, 'mn') || a.code.localeCompare(b.code));
  return {
    id: h.id, number: h.number, date: ymdOf(h.date), driverId: h.driverId, driverName: h.driverName, status: h.status, statusLabel: HANDOVER_STATUS_LABEL[h.status],
    version: h.version, createdAt: h.createdAt, createdByName: h.createdByName, preparedAt: h.preparedAt, preparedBy: h.preparedBy, handedOverAt: h.handedOverAt, handedOverBy: h.handedOverBy,
    receivedAt: h.receivedAt, receivedBy: h.receivedBy,
    canOperate,
    totals: {
      orders: active.length, pieces: items.reduce((a, x) => a + x.qty, 0), amount: active.reduce((a, x) => a + x.o.total, 0),
      checked: items.filter((x) => x.checked).length + extras.filter((x) => x.checked).length,
      driverChecked: items.filter((x) => x.driverChecked).length + extras.filter((x) => x.driverChecked).length,
      kinds: items.length + extras.length,
      extraPieces: extras.reduce((a, x) => a + x.qty, 0), extraAmount: extras.reduce((a, x) => a + x.amount, 0), extraRequests: xdocs.length,
    },
    items, extras,
    orders: h.orders.map((x) => {
      const o = om.get(x.orderId);
      return {
        orderId: x.orderId, position: x.position, number: o?.number ?? '?', phone: o?.phone ?? '', total: o?.total ?? 0, originalTotal: o?.originalTotal ?? null, createdAt: o?.createdAt ?? null, status: o?.status ?? null,
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
  const driver = await db.user.findUnique({ where: { id: driverId }, select: { id: true, name: true, roles: true, isActive: true } });
  if (!driver || !driver.roles.includes('DRIVER')) throw badRequest('Жолооч олдсонгүй');
  if (!driver.isActive) throw badRequest('Жолооч идэвхгүй болсон — падаан үүсгэхгүй', 'inactive_driver'); // Аудит #147
  const res = await inTx(async (tx) => {
    await lockDrivers(tx, [driverId]);
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
    // Жолоочийн тэр өдрийн нэмэлт барааны хүсэлтүүд падаанд тусдаа орно (#80)
    await tx.driverDoc.updateMany({ where: { driverId, kind: 'EXTRA_TAKE', status: 'REQUESTED', date: dateOnly(date), handoverId: null }, data: { handoverId: h.id } });
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
export async function setCheck(actor: UserActor, idInput: unknown, input: { variantId?: unknown; checked?: unknown; kind?: unknown }) {
  assertOperate(actor);
  const id = cleanHid(idInput);
  const variantId = Number(input.variantId);
  const kind = input.kind === 'EXTRA' ? 'EXTRA' : 'ORDER';
  if (!Number.isInteger(variantId)) throw badRequest('Бараа буруу');
  await inTx(async (tx) => {
    const h = await loadForChange(tx, id);
    if (isGiven(h.status)) throw conflict('Бараа өгөгдсөн падаан', 'handed_over');
    const inSheet = kind === 'ORDER'
      ? await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM "HandoverOrder" ho JOIN "OrderLine" l ON l."orderId" = ho."orderId"
        WHERE ho."handoverId" = ${id} AND ho."removedAt" IS NULL AND l."variantId" = ${variantId}`
      : await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM "DriverDoc" d JOIN "DriverDocLine" l ON l."docId" = d.id
        WHERE d."handoverId" = ${id} AND d.kind = 'EXTRA_TAKE' AND d.status = 'REQUESTED' AND l."variantId" = ${variantId}`;
    if (!inSheet[0]?.n) throw badRequest('Энэ бараа падаанд алга');
    if (input.checked === false) await tx.handoverCheck.deleteMany({ where: { handoverId: id, variantId, kind } });
    else await tx.handoverCheck.upsert({ where: { handoverId_variantId_kind: { handoverId: id, variantId, kind } }, create: { handoverId: id, variantId, kind, checkedBy: actor.name }, update: {} });
    // Агуулахын шалгалт түүхэнд (#124-Г)
    await writeAudit(actor, input.checked === false ? 'handover.uncheck' : 'handover.check', 'Handover', String(id), { number: h.number, variantId, kind }, tx, ['delivery']);
  });
  return { ok: true };
}

/** «Бэлтгэсэн» (Ноорог → Бэлтгэсэн) */
export async function prepareHandover(actor: UserActor, idInput: unknown) {
  assertOperate(actor);
  const id = cleanHid(idInput);
  await inTx(async (tx) => {
    const h = await loadForChange(tx, id);
    if (h.status !== 'DRAFT') return;
    await tx.handover.update({ where: { id }, data: { status: 'PREPARED', preparedAt: new Date(), preparedBy: actor.name, preparedById: actor.id, version: { increment: 1 } } });
    await writeAudit(actor, 'handover.prepared', 'Handover', String(id), { number: h.number }, tx, ['delivery']);
  });
  return handoverDetail(actor, id);
}

/**
 * Агуулах «Барааг бүрэн өгсөн» — бүх бараа Check хийгдсэн байх ёстой (#65). Падаан «Жолооч хүлээн авна» болно (#77):
 * бараа хараахан агуулахад, захиалгууд «Жолоочид оноосон» хэвээр. Жолооч утсаараа чагтлаад «Барааг бүрэн хүлээн авсан»
 * дармагц (receiveHandover) л бараа жолоочид шилжиж, захиалгууд «Хүргэлтэд гарсан». Зэрэг дарахад нэг л удаа.
 */
export async function confirmHandover(actor: UserActor, idInput: unknown) {
  assertOperate(actor);
  const id = cleanHid(idInput);
  let duplicate = false;
  await inTx(async (tx) => {
    await lockHandoverDriver(tx, id);
    const h = await loadForChange(tx, id);
    if (isGiven(h.status)) { duplicate = true; return; }
    if (h.status !== 'PREPARED') throw conflict('Эхлээд «Бэлтгэсэн» дарна уу', 'not_prepared');
    const { orders, qty } = await sheetOrders(tx, id, h.driverId);
    const { xqty } = await sheetExtras(tx, id);
    const all = await tx.handoverCheck.findMany({ where: { handoverId: id }, select: { variantId: true, kind: true } });
    const checks = new Set(all.filter((c) => c.kind === 'ORDER').map((c) => c.variantId));
    const xchecks = new Set(all.filter((c) => c.kind === 'EXTRA').map((c) => c.variantId));
    const unchecked = [...qty.keys()].filter((v) => !checks.has(v)).length + [...xqty.keys()].filter((v) => !xchecks.has(v)).length;
    if (unchecked) throw conflict(`${unchecked} бараа Check хийгдээгүй байна — бүх барааг (нэмэлт барааг ч) шалгана уу`, 'not_checked');
    // Үндсэн агуулахад хүрэлцэх эсэхийг одоо шалгана (жолооч хүлээн авах үед захиалгын ба нэмэлт бараа эндээс гарна)
    const need = new Map(qty);
    for (const [v, q] of xqty) need.set(v, (need.get(v) ?? 0) + q);
    const wh = await tx.warehouse.findUnique({ where: { id: h.warehouseId }, include: { location: true } });
    const locId = wh?.location?.id ?? -1;
    // Аудит #147: барааны түгжээ (шилжүүлэг, зарлага, өөр падаантай нэг дараалал) — хоёр падаан сүүлийн барааг зэрэг «өгөхгүй»
    await tx.$queryRaw`SELECT count(pg_advisory_xact_lock(2::int4, v))::int AS n FROM (SELECT DISTINCT unnest(${[...need.keys()]}::int[]) AS v ORDER BY 1) s`;
    const others = await handedOverNeed(tx, [...need.keys()], { locationIds: [locId], excludeHandoverId: id });
    const bal = new Map((await tx.stockBalance.findMany({ where: { locationId: locId, variantId: { in: [...need.keys()] } } })).map((b) => [b.variantId, b.qty]));
    const have = new Map([...need.keys()].map((v) => [v, Math.max(0, (bal.get(v) ?? 0) - (others.get(`${locId}:${v}`) ?? 0))]));
    const short = [...need].filter(([v, q]) => (have.get(v) ?? 0) < q);
    if (short.length) {
      const names = new Map([...orders.flatMap((o) => o.lines.map((l) => [l.variantId, `${l.name}${l.label ? ` · ${l.label}` : ''}`] as const)), ...[...(await variantInfo([...xqty.keys()]))].map(([v, i]) => [v, `${i.name}${i.label ? ` · ${i.label}` : ''}`] as const)]);
      throw conflict(short.map(([v, q]) => { const o = others.get(`${locId}:${v}`) ?? 0; return `«${names.get(v)}» үндсэн агуулахад хүрэлцэхгүй: байгаа ${have.get(v) ?? 0}${o ? ` (${o} нь өөр жолоочид өгөгдсөн, хүлээн авахыг хүлээж буй)` : ''}, өгөх ${q}`; }).join('; '), 'insufficient_stock');
    }
    await tx.handover.update({ where: { id }, data: { status: 'HANDED_OVER', handedOverAt: new Date(), handedOverBy: actor.name, version: { increment: 1 } } });
    await writeAudit(actor, 'handover.handed_over', 'Handover', String(id), {
      number: h.number, driver: h.driverName, orders: orders.length, pieces: [...qty.values()].reduce((a, b) => a + b, 0), note: 'Жолооч утсаараа хүлээн авна',
      lines: [...need].map(([variantId, q]) => ({ variantId, qty: q })),
    }, tx, ['delivery']);
  });
  bustCounts();
  return { ...(await handoverDetail(actor, id)), duplicate };
}

/** Падаанд орсон, хараахан өгөөгүй нэмэлт барааны хүсэлтүүд (#80) */
async function sheetExtras(tx: Prisma.TransactionClient, id: number) {
  const docs = await tx.driverDoc.findMany({ where: { handoverId: id, kind: 'EXTRA_TAKE', status: 'REQUESTED' }, include: { lines: true } });
  const xqty = new Map<number, number>();
  for (const d of docs) for (const l of d.lines) xqty.set(l.variantId, (xqty.get(l.variantId) ?? 0) + l.qty);
  return { docs, xqty };
}

/** Падааны идэвхтэй захиалгууд (бүгд тэр жолоочид оноосон, хүргэлтэд гараагүй) ба нэгтгэсэн бараа */
async function sheetOrders(tx: Prisma.TransactionClient, id: number, driverId: string) {
  const hos = await tx.handoverOrder.findMany({ where: { handoverId: id, removedAt: null }, select: { orderId: true } });
  if (!hos.length) throw badRequest('Падаанд захиалга алга');
  const orderIds = hos.map((x) => x.orderId);
  await lockOrders(tx, orderIds);
  const orders = await tx.order.findMany({ where: { id: { in: orderIds } }, include: { lines: true } });
  const bad = orders.find((o) => o.status !== 'ASSIGNED' || o.driverId !== driverId);
  if (bad) throw conflict(`№${bad.number} захиалга өөрчлөгдсөн байна — дахин ачаална уу`, 'stale');
  const qty = new Map<number, number>();
  for (const o of orders) for (const l of o.lines) qty.set(l.variantId, (qty.get(l.variantId) ?? 0) + l.qty);
  return { orders, orderIds, qty };
}

const assertDriverRole = (a: UserActor) => { if (!canDrive(a.roles)) throw forbidden('Падааныг жолооч өөрөө хүлээн авна'); };

/** Жолоочийн падаан (утсанд): өнөөдрийнх, эсвэл хүлээн аваагүй үлдсэн хамгийн сүүлийнх */
export async function myHandover(actor: UserActor) {
  assertDriverRole(actor);
  const today = ubDay();
  // Аудит #147: хүлээн авах (агуулах өгсөн) падаан эхэнд — өчигдрийнх өнөөдрийн ноорогт дарагдаж нуугдахгүй
  const h = (await db.handover.findFirst({ where: { driverId: actor.id, status: 'HANDED_OVER' }, orderBy: [{ date: 'asc' }], select: { id: true } }))
    ?? (await db.handover.findFirst({ where: { driverId: actor.id, date: dateOnly(today) }, select: { id: true } }));
  const pending = await db.handover.count({ where: { driverId: actor.id, status: 'HANDED_OVER' } });
  if (!h) return { today, pending, handover: null };
  const d = await buildDetail(h.id, false);
  // Аудит #144 (#77): агуулах «өгсөн» болохоос өмнө жолоочид захиалгын утас, дүн, бараа харагдахгүй — зөвхөн хаяг, тоо
  if (d.status === 'DRAFT' || d.status === 'PREPARED') {
    return { today, pending, handover: { ...d, totals: { ...d.totals, amount: 0, extraAmount: 0 }, items: [], extras: [],
      orders: d.orders.map((o) => ({ ...o, phone: '', total: 0, note: null, lines: [] })), hidden: true } };
  }
  return { today, pending, handover: d };
}

/** Аудит #144: цэсний тэмдэгт — зөвхөн хүлээн авах падааны тоо (бүтэн падаан ачаалахгүй) */
export async function myHandoverPending(actor: UserActor) {
  assertDriverRole(actor);
  return { pending: await db.handover.count({ where: { driverId: actor.id, status: 'HANDED_OVER' } }) };
}

/** Жолооч бараа бүрийг чагтална (агуулах Check хийсэн бараа л; «Бүгд» — variantId: 'all') */
export async function setDriverCheck(actor: UserActor, idInput: unknown, input: { variantId?: unknown; checked?: unknown; kind?: unknown }) {
  assertDriverRole(actor);
  const id = cleanHid(idInput);
  await inTx(async (tx) => {
    const h = await loadForChange(tx, id);
    if (h.driverId !== actor.id) throw notFound('Падаан олдсонгүй');
    if (h.status !== 'HANDED_OVER') throw conflict(h.status === 'RECEIVED' ? 'Падааныг аль хэдийн хүлээн авсан' : 'Агуулах барааг өгөөгүй байна', 'bad_status');
    const value = input.checked === false ? null : new Date();
    if (input.variantId === 'all') await tx.handoverCheck.updateMany({ where: { handoverId: id }, data: { driverCheckedAt: value } });
    else {
      const variantId = Number(input.variantId);
      const kind = input.kind === 'EXTRA' ? 'EXTRA' : 'ORDER';
      const n = await tx.handoverCheck.updateMany({ where: { handoverId: id, variantId, kind }, data: { driverCheckedAt: value } });
      if (!n.count) throw badRequest('Энэ бараа падаанд алга');
    }
    // Жолоочийн шалгалт түүхэнд (#124-Г)
    await writeAudit(actor, value ? 'handover.driver_check' : 'handover.driver_uncheck', 'Handover', String(id), { number: h.number, variantId: input.variantId === 'all' ? 'all' : Number(input.variantId) }, tx, ['delivery']);
  });
  return buildDetail(id, false);
}

/**
 * Жолооч «Барааг бүрэн хүлээн авсан» (#77): бүх бараа чагтлагдсан байх ёстой. Бараа үндсэн агуулахаас жолоочийн гарт
 * журналаар шилжинэ (HANDOVER), нөөц суллагдана, захиалгууд «Хүргэлтэд гарсан». Зэрэг дарахад нэг л удаа.
 */
export async function receiveHandover(actor: UserActor, idInput: unknown) {
  assertDriverRole(actor);
  const id = cleanHid(idInput);
  let duplicate = false;
  await inTx(async (tx) => {
    await lockDrivers(tx, [actor.id]);
    const h = await loadForChange(tx, id);
    if (h.driverId !== actor.id) throw notFound('Падаан олдсонгүй');
    if (h.status === 'RECEIVED') { duplicate = true; return; }
    if (h.status !== 'HANDED_OVER') throw conflict('Агуулах «Барааг бүрэн өгсөн» дараагүй байна', 'not_handed_over');
    const { orderIds, qty } = await sheetOrders(tx, id, h.driverId);
    const { docs: xdocs, xqty } = await sheetExtras(tx, id);
    const checks = await tx.handoverCheck.findMany({ where: { handoverId: id } });
    const ok = new Set(checks.filter((c) => c.driverCheckedAt && c.kind === 'ORDER').map((c) => c.variantId));
    const xok = new Set(checks.filter((c) => c.driverCheckedAt && c.kind === 'EXTRA').map((c) => c.variantId));
    const left = [...qty.keys()].filter((v) => !ok.has(v)).length + [...xqty.keys()].filter((v) => !xok.has(v)).length;
    if (left) throw conflict(`${left} бараа чагтлагдаагүй — бүх барааг (нэмэлт барааг ч) чагтална уу (дутуу бол агуулахад хэлнэ)`, 'not_checked');
    const wh = await tx.warehouse.findUnique({ where: { id: h.warehouseId }, include: { location: true } });
    if (!wh?.location) throw badRequest('Агуулах олдсонгүй');
    const toId = await driverLocationId(tx, { id: h.driverId, name: h.driverName });
    const moves: MoveSpec[] = [...qty.entries()].map(([variantId, q]) => ({ type: 'HANDOVER', variantId, qty: q, fromId: wh.location!.id, toId, note: `${h.number} · ${h.driverName} хүлээн авсан` }));
    for (const [variantId, q] of xqty) moves.push({ type: 'EXTRA_OUT', variantId, qty: q, fromId: wh.location!.id, toId, note: `${h.number} · нэмэлт бараа` });
    await applyMoves(tx, actor, { type: 'handover', id }, moves);
    await tx.stockReservation.deleteMany({ where: { orderId: { in: orderIds } } });
    // Нэмэлт бараа: хүсэлтийн нөөц суллагдаж, «падаанаар авсан» болно
    if (xdocs.length) {
      await tx.stockReservation.deleteMany({ where: { ref: { in: xdocs.map((d) => `extra:${d.id}`) } } });
      await tx.driverDoc.updateMany({ where: { id: { in: xdocs.map((d) => d.id) } }, data: { status: 'GIVEN' } });
    }
    const now = new Date();
    await tx.order.updateMany({ where: { id: { in: orderIds } }, data: { status: 'OUT_FOR_DELIVERY', outForDeliveryAt: now, version: { increment: 1 } } });
    await tx.handover.update({ where: { id }, data: { status: 'RECEIVED', receivedAt: now, receivedBy: actor.name, version: { increment: 1 } } });
    await writeAudit(actor, 'handover.received', 'Handover', String(id), {
      number: h.number, orders: orderIds.length, pieces: [...qty.values()].reduce((a, b) => a + b, 0), from: wh.name,
      ...(xqty.size ? { extraPieces: [...xqty.values()].reduce((a, b) => a + b, 0), extraRequests: xdocs.length } : {}),
    }, tx, ['delivery', 'stock']);
  });
  stockCache.today = null; bustCounts();
  return { ...(await buildDetail(id, false)), duplicate };
}

/**
 * «Буцаах»: Бэлтгэсэн → Ноорог (Check арилна); Өгсөн → Ноорог — бараа жолоочоос агуулахад буцаж (журнал),
 * нөөц сэргэж, захиалгууд «Жолоочид оноосон» болно (жолооч хүргэж эхлээгүй үед л — Модуль 5).
 */
export async function revertHandover(actor: UserActor, idInput: unknown) {
  assertOperate(actor);
  const id = cleanHid(idInput);
  await inTx(async (tx) => {
    await lockHandoverDriver(tx, id);
    const h = await loadForChange(tx, id);
    if (h.status === 'DRAFT') return;
    // Аудит #141 (эзний шийдвэр): жолооч хүлээн авсан падааныг ХЭЗЭЭ Ч буцаахгүй — «Маргааш» болсон бараа падаангүй хоцрох,
    // мөнгө тооцоонд орохгүй болох эрсдэлийг бүрэн хаана. Хүлээн авахаас өмнө (Ноорог / Бэлтгэсэн / Агуулах өгсөн) л буцаана.
    if (h.status === 'RECEIVED') throw conflict('Жолооч хүлээн авсан падааныг буцаах боломжгүй — захиалга бүрийг жолооч хүргэсэн / цуцалсан / маргааш болгоно', 'handover_received');
    await tx.handoverCheck.deleteMany({ where: { handoverId: id } });
    await tx.handover.update({ where: { id }, data: { status: 'DRAFT', preparedAt: null, preparedBy: null, handedOverAt: null, handedOverBy: null, receivedAt: null, receivedBy: null, version: { increment: 1 } } });
    // Аудит #147: агуулах өгсөн (жолооч хүлээн аваагүй) падааныг буцаавал — ямар бараа тавиурт буцах ёстойг түүхэнд
    let lines: { variantId: number; qty: number }[] | undefined;
    if (h.status === 'HANDED_OVER') {
      const r = await tx.$queryRaw<{ variantId: number; qty: number }[]>`
        SELECT x."variantId", sum(x.qty)::int AS qty FROM (
          SELECT ol."variantId", ol.qty FROM "HandoverOrder" ho JOIN "OrderLine" ol ON ol."orderId" = ho."orderId" WHERE ho."handoverId" = ${id} AND ho."removedAt" IS NULL
          UNION ALL SELECT dl."variantId", dl.qty FROM "DriverDoc" d JOIN "DriverDocLine" dl ON dl."docId" = d.id WHERE d."handoverId" = ${id} AND d.kind = 'EXTRA_TAKE' AND d.status = 'REQUESTED'
        ) x GROUP BY 1 ORDER BY 1`;
      lines = r;
    }
    await writeAudit(actor, 'handover.reverted', 'Handover', String(id), { number: h.number, from: h.status, ...(lines ? { lines, note: 'Агуулах өгсөн бараа тавиурт буцах ёстой (жолооч хүлээн аваагүй)' } : {}) } as Prisma.InputJsonValue, tx, ['delivery']);
  });
  stockCache.today = null; bustCounts();
  return handoverDetail(actor, id);
}

/** «Падаан буцаах» (зөвхөн Ноорог): падаан устаж, захиалгууд жолоочид оноосон хэвээр үлдэнэ */
export async function deleteHandover(actor: UserActor, idInput: unknown) {
  assertOperate(actor);
  const id = cleanHid(idInput);
  await inTx(async (tx) => {
    await lockHandoverDriver(tx, id);
    const h = await loadForChange(tx, id);
    if (h.status !== 'DRAFT') throw conflict('Эхлээд «Буцаах» дарж ноорог болгоно уу', 'not_draft');
    // Аудит #147: 1 сая захиалгыг бүтэн уншихгүй — падааны мөрүүдээс
    const oids = (await tx.handoverOrder.findMany({ where: { handoverId: id }, select: { orderId: true } })).map((x) => x.orderId);
    if (oids.length) await tx.order.updateMany({ where: { id: { in: oids }, handoverId: id }, data: { handoverId: null } });
    // Нэмэлт барааны хүсэлт хүлээгдэж үлдэнэ — шинэ падаан үүсэхэд дахин орно
    await tx.driverDoc.updateMany({ where: { handoverId: id, status: 'REQUESTED' }, data: { handoverId: null } });
    await tx.handover.delete({ where: { id } });
    await writeAudit(actor, 'handover.deleted', 'Handover', String(id), { number: h.number, driver: h.driverName, date: ymdOf(h.date) }, tx, ['delivery']);
  });
  bustCounts();
  return { deleted: true };
}

/** Падааны түүх (огноо, жолоочоор) — хуудаслагдана (аудит А6, R1) */
const HISTORY_PAGE = 60;
export async function handoverHistory(actor: UserActor, p: { from?: string; to?: string; driverId?: string; page?: number }) {
  assertView(actor);
  const to = p.to && isYmd(p.to) ? p.to : ubDay();
  const from = p.from && isYmd(p.from) ? p.from : ubDay(new Date(), -7);
  // Аудит #147: хамгийн ихдээ 1 жил, 200 хуудас
  if (from > to) throw badRequest('Эхлэх огноо дуусахаас хойш байна');
  if (addDaysYmd(from, 366) < to) throw badRequest('Хугацаа 1 жилээс урт байж болохгүй', 'range_too_long');
  const where = { date: { gte: dateOnly(from), lte: dateOnly(to) }, ...(p.driverId ? { driverId: cleanUuid(p.driverId) } : {}) };
  const page = Math.max(1, Math.min(200, Math.floor(Number(p.page) || 1)));
  const [total, rows] = await Promise.all([db.handover.count({ where }), db.handover.findMany({
    where, orderBy: [{ date: 'desc' }, { id: 'desc' }], skip: (page - 1) * HISTORY_PAGE, take: HISTORY_PAGE, include: { _count: { select: { orders: { where: { removedAt: null } } } } },
  })]);
  return {
    from, to, page, total, pages: Math.max(1, Math.ceil(total / HISTORY_PAGE)),
    items: rows.map((h) => ({
      id: h.id, number: h.number, date: ymdOf(h.date), driverName: h.driverName, status: h.status, statusLabel: HANDOVER_STATUS_LABEL[h.status], orders: h._count.orders,
      createdByName: h.createdByName, createdAt: h.createdAt, handedOverBy: h.handedOverBy, handedOverAt: h.handedOverAt,
    })),
  };
}

// ───────────────────────── Нягтлангийн OKEY / ХОРИГ ─────────────────────────

async function assertDriverUser(id: string) {
  const u = await db.user.findUnique({ where: { id }, select: { roles: true } });
  if (!u || !u.roles.includes('DRIVER')) throw badRequest('Жолооч олдсонгүй');
}

export async function setApproval(actor: UserActor, input: { driverId?: unknown; date?: unknown; approved?: unknown; note?: unknown }) {
  if (!canApproveDrivers(actor.roles)) throw forbidden('OKEY / ХОРИГ-ийг нягтлан, админ тавина');
  const driverId = cleanUuid(input.driverId);
  const date = cleanYmd(input.date);
  const approved = input.approved === true;
  const note = String(input.note ?? '').trim().slice(0, 200) || null;
  if (!approved && !note) throw badRequest('ХОРИГ-ийн шалтгааныг бичнэ үү (жишээ: өр 120,000₮)', 'reason_required');
  await assertDriverUser(driverId);
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
  await assertDriverUser(driverId);
  await db.$transaction(async (tx) => {
    await tx.driverSetting.upsert({ where: { userId: driverId }, create: { userId: driverId, trusted, updatedBy: actor.name }, update: { trusted, updatedBy: actor.name } });
    await writeAudit(actor, 'driver.trusted', 'User', driverId, { trusted }, tx, ['delivery']);
  });
  return { trusted };
}

/** Падаан эхлүүлэхээс өмнө: үндсэн агуулахад хүрэлцэх эсэх (дутуу бол «Дүүргэлт»-ээр татна) */
export async function shortages(actor: UserActor, idInput: unknown, built?: Awaited<ReturnType<typeof buildDetail>>) {
  assertView(actor);
  // Аудит #147: аль хэдийн бэлдсэн дэлгэрэнгүйг дахин тооцоолохгүй; нэмэлт бараа ба өөр жолоочид өгөгдсөн барааг тооцно
  const d = built ?? await handoverDetail(actor, idInput);
  const hw = await db.handover.findUnique({ where: { id: d.id }, select: { warehouseId: true } });
  const loc = hw ? await db.stockLocation.findUnique({ where: { warehouseId: hw.warehouseId }, select: { id: true } }) : null;
  const locId = loc?.id ?? -1;
  const need = new Map<number, { variantId: number; code: string; name: string; qty: number }>();
  for (const i of [...d.items, ...d.extras]) { const e = need.get(i.variantId) ?? { variantId: i.variantId, code: i.code, name: i.name, qty: 0 }; e.qty += i.qty; need.set(i.variantId, e); }
  const vids = [...need.keys()];
  const [bal, others] = await Promise.all([db.stockBalance.findMany({ where: { locationId: locId, variantId: { in: vids } } }), handedOverNeed(db, vids, { locationIds: [locId], excludeHandoverId: d.id })]);
  const bm = new Map(bal.map((b) => [b.variantId, Math.max(0, b.qty - (others.get(`${locId}:${b.variantId}`) ?? 0))]));
  return [...need.values()].filter((i) => (bm.get(i.variantId) ?? 0) < i.qty).map((i) => ({ variantId: i.variantId, code: i.code, name: i.name, need: i.qty, have: bm.get(i.variantId) ?? 0 }));
}
