import { Prisma, type OrderStatus } from '@prisma/client';
import { db } from '../../db';
import { badRequest, forbidden, notFound } from '../../errors';
import { writeAudit } from '../../audit';
import { canAssignDrivers, canView } from '../../permissions';
import { RURAL, UB_DISTRICTS } from '../../geo';
import { dateOnly, ubDay, ubDayStart, ymdOf, isYmd } from '../../ubdate';
import { inTx, type UserActor } from '../orders/core';
import { bustCounts, searchIds, serializeOrder } from '../orders/queries';
import { addDays, addToHandover, cleanYmd, lockDelivery, lockOrders, removeFromHandover, type Tx } from './core';

/**
 * Ахлах жолооч (хуучин ERP-ийн «Ахлах жолооч» хуудас):
 * мөр бүрт эсвэл олноор жолооч хуваарилах, огноо солих. Хүргэх огноо = захиалгын deliveryDate.
 * Дүрэм: он сар өдөртэй, төлбөр хүлээж буй, хүргэлтэд гарсан/дууссан/цуцлагдсан захиалгыг хуваарилахгүй;
 * өнгөрсөн огноотой бол өнөөдөр; тухайн жолоочийн тэр өдрийн падаан «Өгсөн» бол маргааш руу (#65);
 * падаан «Бэлдэж байна/Бэлдсэн» бол түүнд автоматаар нэмэгдэнэ (алга болохгүй).
 */
const assertLead = (a: UserActor) => { if (!canAssignDrivers(a.roles)) throw forbidden('Хуваарилалтыг ахлах жолооч, админ хийнэ'); };
const assertView = (a: UserActor) => { if (!canView(a.roles, 'driver-lead') && !canView(a.roles, 'handover')) throw forbidden(); };

export async function driversList(actor: UserActor, dateInput?: string) {
  // Захиалгын хуудасны «Жолооч» шүүлтүүрт ч хэрэглэнэ
  if (!canView(actor.roles, 'driver-lead') && !canView(actor.roles, 'handover') && !canView(actor.roles, 'orders')) throw forbidden();
  const today = ubDay();
  const date = dateInput && isYmd(dateInput) ? dateInput : today;
  const [drivers, loads] = await Promise.all([
    db.user.findMany({ where: { isActive: true, roles: { has: 'DRIVER' } }, orderBy: { name: 'asc' }, select: { id: true, name: true, phone: true } }),
    db.$queryRaw<{ driverId: string; n: number }[]>`
      SELECT "driverId", count(*)::int AS n FROM "Order"
      WHERE status IN ('ASSIGNED','OUT_FOR_DELIVERY') AND "driverId" IS NOT NULL AND "deliveryDate" = ${dateOnly(date)}::date GROUP BY 1`,
  ]);
  const m = new Map(loads.map((l) => [l.driverId, l.n]));
  return { date, items: drivers.map((d) => ({ ...d, load: m.get(d.id) ?? 0 })) };
}

export interface LeadParams {
  q?: string; assign?: string; deliveryDate?: string; created?: string; district?: string; rural?: boolean;
  status?: string; driverId?: string; page?: number; pageSize?: number;
}
const PAGE_SIZES = [20, 50, 100, 200, 500];

/** Ахлах жолоочийн жагсаалт — анхдагч «Хуваарилаагүй»; цуцлагдсан, төлбөр хүлээж буй, он сар өдөртэйг нуух (хуучин шиг) */
export async function leadOrders(actor: UserActor, p: LeadParams) {
  assertView(actor);
  const tomorrow = dateOnly(ubDay(new Date(), 1));
  const and: Prisma.OrderWhereInput[] = [];
  const assign = p.assign ?? 'unassigned';
  if (p.status) {
    const st = p.status;
    if (st === 'SCHEDULED') and.push({ status: 'NEW', deliveryDate: { gt: tomorrow } });
    else if (st === 'NEW') and.push({ status: 'NEW', deliveryDate: { lte: tomorrow } });
    else if (['PENDING_PAYMENT', 'ASSIGNED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED'].includes(st)) and.push({ status: st as OrderStatus });
    else throw badRequest('Төлөв буруу');
  } else {
    and.push({ OR: [{ status: 'NEW', deliveryDate: { lte: tomorrow } }, { status: { in: ['ASSIGNED', 'OUT_FOR_DELIVERY', 'DELIVERED'] } }] });
  }
  if (assign === 'unassigned') and.push({ driverId: null });
  else if (assign === 'assigned') and.push({ driverId: { not: null } });
  if (p.driverId) { if (!/^[0-9a-f-]{36}$/i.test(p.driverId)) throw badRequest('Жолооч буруу'); and.push({ driverId: p.driverId }); }
  if (p.deliveryDate) and.push({ deliveryDate: dateOnly(cleanYmd(p.deliveryDate)) });
  if (p.created) { const c = cleanYmd(p.created); and.push({ createdAt: { gte: ubDayStart(c), lt: ubDayStart(addDays(c, 1)) } }); }
  if (p.rural) and.push({ province: { in: RURAL } });
  else if (p.district) { if (!(p.district in UB_DISTRICTS)) throw badRequest('Дүүрэг буруу'); and.push({ district: p.district }); }
  if (p.q?.trim()) {
    const q = p.q.trim();
    const drv = await db.user.findMany({ where: { roles: { has: 'DRIVER' }, name: { contains: q, mode: 'insensitive' } }, select: { id: true }, take: 20 });
    const ids = (await searchIds(q)) ?? [];
    and.push({ OR: [{ id: { in: ids.length ? ids : [-1] } }, ...(drv.length ? [{ driverId: { in: drv.map((d) => d.id) } }] : [])] });
  }
  const pageSize = PAGE_SIZES.includes(Number(p.pageSize)) ? Number(p.pageSize) : 50;
  const page = Math.max(1, Math.min(2000, Math.floor(p.page ?? 1)));
  const where: Prisma.OrderWhereInput = { AND: and };
  const rows = await db.order.findMany({ where, orderBy: { id: 'desc' }, skip: (page - 1) * pageSize, take: pageSize + 1, include: { lines: true } });
  const list = rows.slice(0, pageSize);
  const hs = await db.handover.findMany({ where: { id: { in: list.map((o) => o.handoverId).filter((x): x is number => !!x) } }, select: { id: true, number: true, status: true } });
  const hm = new Map(hs.map((h) => [h.id, h]));
  return {
    page, pageSize, hasMore: rows.length > pageSize, canAssign: canAssignDrivers(actor.roles),
    kpi: await leadKpi(),
    items: list.map((o) => ({ ...serializeOrder(o), handover: o.handoverId ? hm.get(o.handoverId) ?? null : null })),
  };
}

let kpiCache: { at: number; data: Record<string, number> } | null = null;
async function leadKpi() {
  if (kpiCache && Date.now() - kpiCache.at < 5000) return kpiCache.data;
  const today = dateOnly(ubDay()); const tomorrow = dateOnly(ubDay(new Date(), 1));
  const r = await db.$queryRaw<{ k: string; n: number }[]>`
    SELECT 'unassigned' AS k, count(*)::int AS n FROM "Order" WHERE status = 'NEW' AND "deliveryDate" <= ${tomorrow}::date AND "driverId" IS NULL
    UNION ALL SELECT 'assignedToday', count(*)::int FROM "Order" WHERE status = 'ASSIGNED' AND "deliveryDate" = ${today}::date
    UNION ALL SELECT 'assignedTomorrow', count(*)::int FROM "Order" WHERE status = 'ASSIGNED' AND "deliveryDate" = ${tomorrow}::date
    UNION ALL SELECT 'outForDelivery', count(*)::int FROM "Order" WHERE status = 'OUT_FOR_DELIVERY'
    UNION ALL SELECT 'deliveredToday', count(*)::int FROM "Order" WHERE status = 'DELIVERED' AND "deliveredAt" >= ${ubDayStart(ubDay())}`;
  const data = Object.fromEntries(r.map((x) => [x.k, x.n]));
  kpiCache = { at: Date.now(), data };
  return data;
}

/** «Жолоочдын захиалга» — өдрийн жолооч бүрийн захиалга (хуучин шиг баруун талын самбар) */
export async function driverOrdersByDay(actor: UserActor, dateInput?: string) {
  assertView(actor);
  const date = dateInput && isYmd(dateInput) ? dateInput : ubDay();
  const rows = await db.order.findMany({
    where: { driverId: { not: null }, deliveryDate: dateOnly(date), status: { in: ['ASSIGNED', 'OUT_FOR_DELIVERY', 'DELIVERED'] } },
    orderBy: [{ driverName: 'asc' }, { id: 'asc' }], include: { lines: true }, take: 3000,
  });
  const by = new Map<string, { driverId: string; driverName: string; orders: ReturnType<typeof serializeOrder>[] }>();
  for (const o of rows) {
    const e = by.get(o.driverId!) ?? { driverId: o.driverId!, driverName: o.driverName ?? '—', orders: [] };
    e.orders.push(serializeOrder(o));
    by.set(o.driverId!, e);
  }
  return { date, drivers: [...by.values()] };
}

/** Захиалгыг жолоочид хуваарилах (нэг эсвэл олноор). Тохирохгүйг алгасаад шалтгааныг буцаана */
export async function assignOrders(actor: UserActor, input: { ids?: unknown; driverId?: unknown }) {
  assertLead(actor);
  const ids = Array.isArray(input.ids) ? [...new Set((input.ids as unknown[]).map(Number))].filter((n) => Number.isInteger(n) && n > 0) : [];
  if (!ids.length) throw badRequest('Захиалга сонгоно уу');
  if (ids.length > 500) throw badRequest('Нэг дор 500 хүртэл захиалга');
  const driver = await db.user.findUnique({ where: { id: String(input.driverId ?? '') }, select: { id: true, name: true, isActive: true, roles: true } });
  if (!driver || !driver.isActive || !driver.roles.includes('DRIVER')) throw badRequest('Жолооч олдсонгүй');
  return assignCore(actor, ids, driver);
}

/**
 * Хуваарилах дүрэм (ахлах жолооч ба жолоочийн «Авах» (Pickup, Модуль 5) хоёулаа үүгээр):
 * pickup = жолооч өөрөө — зөвхөн хуваарилаагүй «Шинэ» захиалгыг авна (өөр жолоочийнхыг булаахгүй).
 */
export async function assignCore(actor: UserActor, ids: number[], driver: { id: string; name: string }, opts: { pickup?: boolean } = {}) {
  const res = await inTx(async (tx) => {
    await lockDelivery(tx);
    await lockOrders(tx, ids);
    const orders = await tx.order.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } });
    const today = ubDay(); const tomorrow = ubDay(new Date(), 1);
    const done: { id: number; number: string; date: string; movedNextDay: boolean }[] = [];
    const skipped: { id: number; number: string; reason: string }[] = [];
    for (const o of orders) {
      const d0 = ymdOf(o.deliveryDate);
      const reason = o.status === 'PENDING_PAYMENT' ? 'Төлбөр хүлээж буй'
        : o.status === 'NEW' && d0 > tomorrow ? 'Он сар өдөртэй захиалга хуваарилах боломжгүй'
        : !['NEW', 'ASSIGNED'].includes(o.status) ? 'Хүргэлтэд гарсан / дууссан / цуцлагдсан'
        : o.status === 'ASSIGNED' && o.driverId === driver.id ? 'Аль хэдийн энэ жолоочид'
        : opts.pickup && (o.status !== 'NEW' || o.driverId) ? 'Өөр жолоочид хуваарилагдсан' : null;
      if (reason) { skipped.push({ id: o.id, number: o.number, reason }); continue; }
      if (o.handoverId) await removeFromHandover(tx, o.id, `Өөр жолоочид (${driver.name}) шилжсэн`);
      const placed = await placeForDriver(tx, o.id, driver, d0 < today ? today : d0);
      await tx.order.update({ where: { id: o.id }, data: { status: 'ASSIGNED', driverId: driver.id, driverName: driver.name, assignedAt: new Date(), outForDeliveryAt: null, version: { increment: 1 } } });
      await writeAudit(actor, opts.pickup ? 'order.picked_up' : 'order.assigned', 'Order', String(o.id), {
        number: o.number, from: o.driverName ?? null, to: driver.name, date: placed.date, ...(placed.movedNextDay ? { note: 'Тэр өдрийн падаан өгөгдсөн тул маргааш' } : {}),
      }, tx, ['order', 'delivery']);
      done.push({ id: o.id, number: o.number, date: placed.date, movedNextDay: placed.movedNextDay });
    }
    return { assigned: done, skipped };
  });
  bustCounts(); kpiCache = null;
  return res;
}

/** Огноог тогтоож, тэр өдрийн падаанд (өгөхөөс өмнө) нэмнэ; өгөгдсөн бол дараагийн өдөр (#65) */
async function placeForDriver(tx: Tx, orderId: number, driver: { id: string }, wanted: string) {
  let date = wanted; let moved = false;
  for (let i = 0; i < 60; i++) {
    const h = await tx.handover.findUnique({ where: { driverId_date: { driverId: driver.id, date: dateOnly(date) } }, select: { id: true, status: true } });
    if (h?.status === 'HANDED_OVER') { date = addDays(date, 1); moved = true; continue; }
    await tx.order.update({ where: { id: orderId }, data: { deliveryDate: dateOnly(date) } });
    if (h) await addToHandover(tx, h.id, orderId);
    break;
  }
  return { date, movedNextDay: moved };
}

/** Огноо солих (мөр бүрт эсвэл олноор, хуучин шиг). Өгөгдсөн падаантай өдөр рүү шилжүүлэхгүй */
export async function setDeliveryDate(actor: UserActor, input: { ids?: unknown; date?: unknown }) {
  assertLead(actor);
  const date = cleanYmd(input.date);
  if (date < ubDay()) throw badRequest('Өнгөрсөн огноо сонгох боломжгүй', 'bad_date');
  if (date > ubDay(new Date(), 120)) throw badRequest('120 хоногоос хол огноо', 'bad_date');
  const ids = Array.isArray(input.ids) ? [...new Set((input.ids as unknown[]).map(Number))].filter((n) => Number.isInteger(n) && n > 0) : [];
  if (!ids.length || ids.length > 500) throw badRequest('Захиалга сонгоно уу');
  const res = await inTx(async (tx) => {
    await lockDelivery(tx);
    await lockOrders(tx, ids);
    const orders = await tx.order.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } });
    const done: number[] = []; const skipped: { id: number; number: string; reason: string }[] = [];
    for (const o of orders) {
      if (!['NEW', 'ASSIGNED'].includes(o.status)) { skipped.push({ id: o.id, number: o.number, reason: 'Хүргэлтэд гарсан / дууссан / цуцлагдсан' }); continue; }
      const from = ymdOf(o.deliveryDate);
      if (from === date) { done.push(o.id); continue; }
      if (o.status === 'ASSIGNED' && o.driverId) {
        const h = await tx.handover.findUnique({ where: { driverId_date: { driverId: o.driverId, date: dateOnly(date) } }, select: { id: true, status: true } });
        if (h?.status === 'HANDED_OVER') { skipped.push({ id: o.id, number: o.number, reason: `${o.driverName}-ийн ${date}-ны падаан өгөгдсөн` }); continue; }
        if (o.handoverId) await removeFromHandover(tx, o.id, `Огноо ${date} болсон`);
        await tx.order.update({ where: { id: o.id }, data: { deliveryDate: dateOnly(date), version: { increment: 1 } } });
        if (h) await addToHandover(tx, h.id, o.id);
      } else {
        await tx.order.update({ where: { id: o.id }, data: { deliveryDate: dateOnly(date), version: { increment: 1 } } });
      }
      await writeAudit(actor, 'order.updated', 'Order', String(o.id), { number: o.number, changes: { deliveryDate: { from, to: date } } } as Prisma.InputJsonValue, tx, ['order', 'delivery']);
      done.push(o.id);
    }
    return { updated: done.length, skipped };
  });
  bustCounts(); kpiCache = null;
  return res;
}

export async function getLeadOrder(actor: UserActor, id: number) {
  assertView(actor);
  const o = await db.order.findUnique({ where: { id }, include: { lines: true } });
  if (!o) throw notFound('Захиалга олдсонгүй');
  return serializeOrder(o);
}
