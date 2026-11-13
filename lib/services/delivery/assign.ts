import { Prisma, type OrderStatus } from '@prisma/client';
import { db } from '../../db';
import { badRequest, forbidden, notFound } from '../../errors';
import { writeAudit } from '../../audit';
import { canAssignDrivers, canView } from '../../permissions';
import { RURAL, UB_DISTRICTS } from '../../geo';
import { dateOnly, ubDay, ubDayStart, ymdOf, isYmd } from '../../ubdate';
import { inTx, orderSettings, type UserActor } from '../orders/core';
import { bustCounts, searchIds, serializeOrder } from '../orders/queries';
import { addDays, addToHandover, assertLockedDrivers, cleanYmd, isGiven, lockDrivers, lockOrders, removeFromHandover, type Tx } from './core';

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
  } else if (assign === 'unassigned') {
    // Аудит #145: хуваарилаагүй = зөвхөн «Шинэ» (хүргэсэн / хүргэлтэд захиалга үргэлж жолоочтой) — 1 сая мөр бүтэн уншихгүй (хэсэгчилсэн индекс)
    and.push({ status: 'NEW', deliveryDate: { lte: tomorrow } });
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
  // Аудит #145: 200-аас хол хуудас хориотой (100,000 мөр алгасах удаан) — шүүлтүүрээр нарийсгана
  const page = Math.max(1, Math.min(200, Math.floor(p.page ?? 1)));
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
    UNION ALL SELECT 'leftover', count(*)::int FROM "Order" WHERE status = 'NEW' AND "deliveryDate" <= ${today}::date AND "driverId" IS NULL
    UNION ALL SELECT 'assignedToday', count(*)::int FROM "Order" WHERE status = 'ASSIGNED' AND "deliveryDate" = ${today}::date
    UNION ALL SELECT 'assignedTomorrow', count(*)::int FROM "Order" WHERE status = 'ASSIGNED' AND "deliveryDate" = ${tomorrow}::date
    UNION ALL SELECT 'outForDelivery', count(*)::int FROM "Order" WHERE status = 'OUT_FOR_DELIVERY'
    UNION ALL SELECT 'deliveredToday', count(*)::int FROM "Order" WHERE status = 'DELIVERED' AND "deliveredAt" >= ${ubDayStart(ubDay())}
    UNION ALL SELECT 'postponedToday', count(*)::int FROM "Order" WHERE "postponedByDriverId" IS NOT NULL AND "postponedAt" >= ${ubDayStart(ubDay())}
    UNION ALL SELECT 'issues', count(*)::int FROM "Order" WHERE "issueStatus" = 'PENDING'`;
  const data = Object.fromEntries(r.map((x) => [x.k, x.n]));
  kpiCache = { at: Date.now(), data };
  return data;
}

/** «Жолоочдын захиалга» — өдрийн жолооч бүрийн захиалга (хуучин шиг баруун талын самбар) */
export async function driverOrdersByDay(actor: UserActor, dateInput?: string, driverIdIn?: string) {
  assertView(actor);
  const date = dateInput && isYmd(dateInput) ? dateInput : ubDay();
  // Аудит #145: эхлээд жолооч бүрийн тоо, дүн (бүх жолооч, тасрахгүй); дэлгэхэд тухайн жолоочийн захиалгыг ачаална
  if (!driverIdIn) {
    const sums = await db.$queryRaw<{ driverId: string; driverName: string | null; n: number; total: bigint }[]>`
      SELECT "driverId", max("driverName") AS "driverName", count(*)::int AS n, COALESCE(sum(total), 0)::bigint AS total FROM "Order"
      WHERE "driverId" IS NOT NULL AND "deliveryDate" = ${dateOnly(date)}::date AND status IN ('ASSIGNED','OUT_FOR_DELIVERY','DELIVERED')
      GROUP BY "driverId" ORDER BY max("driverName")`;
    return { date, drivers: sums.map((x) => ({ driverId: x.driverId, driverName: x.driverName ?? '—', count: x.n, total: Number(x.total), orders: null as ReturnType<typeof serializeOrder>[] | null })) };
  }
  if (!/^[0-9a-f-]{36}$/i.test(driverIdIn)) throw badRequest('Жолооч буруу');
  const rows = await db.order.findMany({
    where: { driverId: driverIdIn, deliveryDate: dateOnly(date), status: { in: ['ASSIGNED', 'OUT_FOR_DELIVERY', 'DELIVERED'] } },
    orderBy: [{ id: 'asc' }], include: { lines: true }, take: 1000,
  });
  const orders = rows.map((o) => serializeOrder(o));
  return { date, drivers: [{ driverId: driverIdIn, driverName: rows[0]?.driverName ?? '—', count: orders.length, total: orders.reduce((a, o) => a + o.total, 0), orders }] };
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
  // Аудит #141: олон захиалгыг 50-аар хэсэгчилж тус бүр богино гүйлгээгээр — нийтлэг түгжээг удаан барихгүй
  // Аудит #145: хэсэг дундуур алдаа гарвал өмнөх хэсгүүд хадгалагдсан тул «хэсэгчлэн амжилттай»-г зөв буцаана; кэш үргэлж цэвэрлэнэ
  const out = { assigned: [] as Awaited<ReturnType<typeof assignChunk>>['assigned'], skipped: [] as Awaited<ReturnType<typeof assignChunk>>['skipped'], failed: null as null | { count: number; message: string } };
  const sorted = [...ids].sort((a, b) => a - b);
  try {
    for (let i = 0; i < sorted.length; i += 50) {
      try {
        const r = await assignChunk(actor, sorted.slice(i, i + 50), driver, opts);
        out.assigned.push(...r.assigned); out.skipped.push(...r.skipped);
      } catch (e) {
        if (i === 0) throw e; // юу ч хийгдээгүй — энгийн алдаа
        out.failed = { count: sorted.length - i, message: e instanceof Error ? e.message : 'Алдаа' };
        break;
      }
    }
    return out;
  } finally { bustCounts(); kpiCache = null; bustUnassignedAlert(); }
}

/** Аудит #147: захиалгуудын одоогийн жолооч + шинэ жолоочийн түгжээ (бусад жолооч зэрэг ажиллана) */
async function lockChunkDrivers(tx: Tx, ids: number[], extra: string[]) {
  const pre = await tx.order.findMany({ where: { id: { in: ids } }, select: { driverId: true } });
  return lockDrivers(tx, [...extra, ...pre.map((o) => o.driverId)]);
}

async function assignChunk(actor: UserActor, ids: number[], driver: { id: string; name: string }, opts: { pickup?: boolean }) {
  return inTx(async (tx) => {
    const locked = await lockChunkDrivers(tx, ids, [driver.id]);
    await lockOrders(tx, ids);
    const orders = await tx.order.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } });
    const hoCache = new Map<string, { id: number; status: string } | null>();
    const given = await givenHandovers(tx, orders);
    const today = ubDay(); const tomorrow = ubDay(new Date(), 1);
    const done: { id: number; number: string; date: string; movedNextDay: boolean }[] = [];
    const skipped: { id: number; number: string; reason: string }[] = [];
    for (const o of orders) {
      const d0 = ymdOf(o.deliveryDate);
      // Аудит #147: түгжээ хүлээх хооронд өөр жолоочид оноогдсон (жишээ нь хоёр жолооч зэрэг «Авах») — алгасна
      const reason = o.driverId && !locked.has(o.driverId) ? 'Яг одоо өөр жолоочид хуваарилагдсан'
        : o.status === 'PENDING_PAYMENT' ? 'Төлбөр хүлээж буй'
        : o.status === 'NEW' && d0 > tomorrow ? 'Он сар өдөртэй захиалга хуваарилах боломжгүй'
        : !['NEW', 'ASSIGNED'].includes(o.status) ? 'Хүргэлтэд гарсан / дууссан / цуцлагдсан'
        : o.status === 'ASSIGNED' && o.driverId === driver.id ? 'Аль хэдийн энэ жолоочид'
        : opts.pickup && (o.status !== 'NEW' || o.driverId) ? 'Өөр жолоочид хуваарилагдсан'
        // Аудит А5 (хуучин шиг): агуулахаас өгөгдсөн падаантай захиалгыг алгасаад бусдыг онооно
        : o.handoverId && given.has(o.handoverId) ? `Падаан (${given.get(o.handoverId)}) агуулахаас өгөгдсөн` : null;
      if (reason) { skipped.push({ id: o.id, number: o.number, reason }); continue; }
      if (o.handoverId) await removeFromHandover(tx, o.id, `Өөр жолоочид (${driver.name}) шилжсэн`);
      const placed = await placeForDriver(tx, o.id, driver, d0 < today ? today : d0, hoCache);
      await tx.order.update({ where: { id: o.id }, data: { status: 'ASSIGNED', driverId: driver.id, driverName: driver.name, assignedAt: new Date(), outForDeliveryAt: null, version: { increment: 1 } } });
      await writeAudit(actor, opts.pickup ? 'order.picked_up' : 'order.assigned', 'Order', String(o.id), {
        number: o.number, from: o.driverName ?? null, to: driver.name, date: placed.date, ...(placed.movedNextDay ? { note: 'Тэр өдрийн падаан өгөгдсөн тул маргааш' } : {}),
      }, tx, ['order', 'delivery']);
      done.push({ id: o.id, number: o.number, date: placed.date, movedNextDay: placed.movedNextDay });
    }
    return { assigned: done, skipped };
  });
}

/** Агуулахаас өгөгдсөн (өөрчлөх боломжгүй) падаанууд: id → дугаар */
async function givenHandovers(tx: Tx, orders: { handoverId: number | null }[]) {
  const hids = [...new Set(orders.map((o) => o.handoverId).filter((x): x is number => !!x))];
  const hs = hids.length ? await tx.handover.findMany({ where: { id: { in: hids } }, select: { id: true, number: true, status: true } }) : [];
  return new Map(hs.filter((h) => isGiven(h.status)).map((h) => [h.id, h.number]));
}

/** Огноог тогтоож, тэр өдрийн падаанд (өгөхөөс өмнө) нэмнэ; өгөгдсөн бол дараагийн өдөр (#65) */
async function placeForDriver(tx: Tx, orderId: number, driver: { id: string }, wanted: string, cache?: Map<string, { id: number; status: string } | null>) {
  let date = wanted; let moved = false;
  for (let i = 0; i < 60; i++) {
    // Аудит #147: нэг хэсэгт ижил өдрийн падааныг дахин дахин уншихгүй (жолоочийн түгжээтэй тул өөрчлөгдөхгүй)
    let h = cache?.get(date);
    if (h === undefined) { h = await tx.handover.findUnique({ where: { driverId_date: { driverId: driver.id, date: dateOnly(date) } }, select: { id: true, status: true } }); cache?.set(date, h); }
    if (h && isGiven(h.status)) { date = addDays(date, 1); moved = true; continue; }
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
  // Аудит #144: 50-аар хэсэгчилж тус бүр богино гүйлгээгээр — нийтлэг түгжээг удаан барьж жолоочдыг «завгүй» болгохгүй
  const sorted = [...ids].sort((a, b) => a - b);
  const res = { updated: 0, unassigned: 0, skipped: [] as { id: number; number: string; reason: string }[], failed: null as null | { count: number; message: string } };
  try {
    for (let i = 0; i < sorted.length; i += 50) {
      try {
        const r = await dateChunk(actor, sorted.slice(i, i + 50), date);
        res.updated += r.updated; res.unassigned += r.unassigned; res.skipped.push(...r.skipped);
      } catch (e) {
        if (i === 0) throw e;
        res.failed = { count: sorted.length - i, message: e instanceof Error ? e.message : 'Алдаа' };
        break;
      }
    }
    return res;
  } finally { bustCounts(); kpiCache = null; bustUnassignedAlert(); }
}

async function dateChunk(actor: UserActor, ids: number[], date: string) {
  return inTx(async (tx) => {
    const locked = await lockChunkDrivers(tx, ids, []);
    await lockOrders(tx, ids);
    const orders = await tx.order.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } });
    assertLockedDrivers(locked, orders.map((o) => o.driverId));
    const given = await givenHandovers(tx, orders);
    const done: number[] = []; const skipped: { id: number; number: string; reason: string }[] = []; let unassigned = 0;
    const tomorrow = ubDay(new Date(), 1);
    for (const o of orders) {
      if (!['NEW', 'ASSIGNED'].includes(o.status)) { skipped.push({ id: o.id, number: o.number, reason: 'Хүргэлтэд гарсан / дууссан / цуцлагдсан' }); continue; }
      if (o.handoverId && given.has(o.handoverId)) { skipped.push({ id: o.id, number: o.number, reason: `Падаан (${given.get(o.handoverId)}) агуулахаас өгөгдсөн` }); continue; }
      const from = ymdOf(o.deliveryDate);
      if (from === date) { done.push(o.id); continue; }
      if (o.status === 'ASSIGNED' && o.driverId && date > tomorrow) {
        // Аудит #145: оноосон захиалгыг хол (нөгөөдөр+) огноо руу шилжүүлбэл «Он сар өдөртэй» — жолоочоос чөлөөлж «Шинэ» болгоно
        if (o.handoverId) await removeFromHandover(tx, o.id, `Огноо ${date} болсон (он сар өдөртэй)`);
        await tx.order.update({ where: { id: o.id }, data: { status: 'NEW', driverId: null, driverName: null, assignedAt: null, deliveryDate: dateOnly(date), version: { increment: 1 } } });
        await writeAudit(actor, 'order.updated', 'Order', String(o.id), { number: o.number, changes: { deliveryDate: { from, to: date }, driver: { from: o.driverName, to: null }, status: { from: 'ASSIGNED', to: 'NEW' } } } as Prisma.InputJsonValue, tx, ['order', 'delivery']);
        done.push(o.id); unassigned++;
        continue;
      }
      if (o.status === 'ASSIGNED' && o.driverId) {
        const h = await tx.handover.findUnique({ where: { driverId_date: { driverId: o.driverId, date: dateOnly(date) } }, select: { id: true, status: true } });
        if (h && isGiven(h.status)) { skipped.push({ id: o.id, number: o.number, reason: `${o.driverName}-ийн ${date}-ны падаан өгөгдсөн` }); continue; }
        if (o.handoverId) await removeFromHandover(tx, o.id, `Огноо ${date} болсон`);
        await tx.order.update({ where: { id: o.id }, data: { deliveryDate: dateOnly(date), version: { increment: 1 } } });
        if (h) await addToHandover(tx, h.id, o.id);
      } else {
        await tx.order.update({ where: { id: o.id }, data: { deliveryDate: dateOnly(date), version: { increment: 1 } } });
      }
      await writeAudit(actor, 'order.updated', 'Order', String(o.id), { number: o.number, changes: { deliveryDate: { from, to: date } } } as Prisma.InputJsonValue, tx, ['order', 'delivery']);
      done.push(o.id);
    }
    return { updated: done.length, unassigned, skipped };
  });
}

export async function getLeadOrder(actor: UserActor, id: number) {
  assertView(actor);
  const o = await db.order.findUnique({ where: { id }, include: { lines: true } });
  if (!o) throw notFound('Захиалга олдсонгүй');
  return serializeOrder(o);
}

// ───────────────────────── Жолоочийн гүйцэтгэл, график (хуучин шиг, алдааг зассан — #77) ─────────────────────────

/**
 * «Жолоочийн гүйцэтгэл»: хугацаанд (падааны өдрөөр — цалинтай ижил) жолооч бүрийн Хүргэсэн, Цуцалсан (жолоочид тооцогдох),
 * Маргааш, Амжилт = хүргэсэн ÷ (хүргэсэн + цуцалсан + маргааш). Бусдын буруугаар цуцлагдсан («хасагдсан») тоологдохгүй.
 */
export async function leadPerformance(actor: UserActor, p: { from?: string; to?: string; driverId?: string }) {
  if (!canView(actor.roles, 'driver-lead')) throw forbidden(); // хуучин шиг: SA, A, ахлах жолооч
  const to = p.to && isYmd(p.to) ? p.to : ubDay();
  const from = p.from && isYmd(p.from) ? p.from : ubDay(new Date(), -6);
  if (from > to) throw badRequest('Эхлэх огноо дуусахаас хойш байна');
  // Аудит #145: хамгийн ихдээ 1 жил (366 хоног) — хязгааргүй хугацаа бүх түүхийг уншдаг байв
  if (addDays(from, 365) < to) throw badRequest('Хугацаа 1 жилээс урт байж болохгүй', 'range_too_long');
  const drv = p.driverId ? (/^[0-9a-f-]{36}$/i.test(p.driverId) ? p.driverId : (() => { throw badRequest('Жолооч буруу'); })()) : null;
  // Аудит #145: ЦАЛИНТАЙ ЯГ ИЖИЛ томьёо (calc.ts computeDay): падааны өдрөөр; бусдын буруугаар цуцлагдсан (асуудал — жолоочийн биш,
  // оператор цуцалсан) тоологдохгүй; «Маргааш» тооцох захиалгад орно. Гүйцэтгэл = хүргэсэн ÷ (хүргэсэн + цуцалсан + маргааш)
  const rows = await db.$queryRaw<{ id: string; delivered: number; revenue: bigint; cancelled: number; excluded: number; postponed: number }[]>`
    SELECT h."driverId" AS id,
      count(*) FILTER (WHERE ho."removedAt" IS NULL AND o.status = 'DELIVERED')::int AS delivered,
      COALESCE(sum(o.total) FILTER (WHERE ho."removedAt" IS NULL AND o.status = 'DELIVERED'), 0)::bigint AS revenue,
      count(*) FILTER (WHERE ho."removedAt" IS NULL AND o.status = 'CANCELLED' AND NOT (
        COALESCE(o."cancelReason"::text = 'ISSUE' AND o."issueFault" IS DISTINCT FROM 'DRIVER', false) OR COALESCE(o."issueFault"::text = 'OPERATOR' AND o."cancelReason" IS DISTINCT FROM 'DRIVER_CANCELLED', false)))::int AS cancelled,
      count(*) FILTER (WHERE ho."removedAt" IS NULL AND o.status = 'CANCELLED' AND (
        COALESCE(o."cancelReason"::text = 'ISSUE' AND o."issueFault" IS DISTINCT FROM 'DRIVER', false) OR COALESCE(o."issueFault"::text = 'OPERATOR' AND o."cancelReason" IS DISTINCT FROM 'DRIVER_CANCELLED', false)))::int AS excluded,
      count(*) FILTER (WHERE ho."removedAt" IS NOT NULL)::int AS postponed
    FROM "Handover" h
    JOIN "HandoverOrder" ho ON ho."handoverId" = h.id
    JOIN "Order" o ON o.id = ho."orderId"
    WHERE h.date >= ${dateOnly(from)}::date AND h.date <= ${dateOnly(to)}::date
      AND (ho."removedAt" IS NULL AND o."handoverId" = h.id OR ho."removeReason" = 'Маргааш (бараа жолоочид)')
      AND (${drv}::uuid IS NULL OR h."driverId" = ${drv}::uuid)
    GROUP BY h."driverId"`;
  const users = await db.user.findMany({ where: { id: { in: rows.map((r) => r.id) } }, select: { id: true, name: true, phone: true } });
  const um = new Map(users.map((u) => [u.id, u]));
  const rate = (d: number, c: number, pp: number) => (d + c + pp ? Math.round((d / (d + c + pp)) * 1000) / 10 : null);
  const items = rows.map((r) => ({ id: r.id, name: um.get(r.id)?.name ?? '—', phone: um.get(r.id)?.phone ?? '', delivered: r.delivered, cancelled: r.cancelled, excluded: r.excluded, postponed: r.postponed, total: r.delivered + r.cancelled + r.postponed, revenue: Number(r.revenue), rate: rate(r.delivered, r.cancelled, r.postponed) }))
    .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || b.delivered - a.delivered || a.name.localeCompare(b.name, 'mn'));
  const sum = (k: 'delivered' | 'cancelled' | 'postponed' | 'revenue' | 'excluded') => items.reduce((n, x) => n + x[k], 0);
  return { from, to, items, totals: { delivered: sum('delivered'), cancelled: sum('cancelled'), excluded: sum('excluded'), postponed: sum('postponed'), revenue: sum('revenue'), total: sum('delivered') + sum('cancelled') + sum('postponed'), rate: rate(sum('delivered'), sum('cancelled'), sum('postponed')) } };
}

/** «График»: сүүлийн 14 хоног (Улаанбаатарын өдрөөр, хуучны 1 өдөр хазайдаг алдаагүй) — хүргэсэн, цуцалсан, маргааш; жолоочоор шүүх */
export async function leadChart(actor: UserActor, p: { days?: number; driverId?: string }) {
  if (!canView(actor.roles, 'driver-lead')) throw forbidden(); // хуучин шиг: SA, A, ахлах жолооч
  const days = [7, 14, 30].includes(Number(p.days)) ? Number(p.days) : 14;
  const today = ubDay(); const from = addDays(today, -(days - 1));
  const t0 = ubDayStart(from); const t1 = ubDayStart(addDays(today, 1));
  const drv = p.driverId ? (/^[0-9a-f-]{36}$/i.test(p.driverId) ? p.driverId : (() => { throw badRequest('Жолооч буруу'); })()) : null;
  const rows = await db.$queryRaw<{ day: string; delivered: number; cancelled: number; postponed: number }[]>`
    SELECT to_char(day, 'YYYY-MM-DD') AS day, sum(d)::int AS delivered, sum(c)::int AS cancelled, sum(p)::int AS postponed FROM (
      SELECT ("deliveredAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Ulaanbaatar')::date AS day, 1 AS d, 0 AS c, 0 AS p FROM "Order"
        WHERE status = 'DELIVERED' AND "driverId" IS NOT NULL AND "deliveredAt" >= ${t0} AND "deliveredAt" < ${t1} AND (${drv}::uuid IS NULL OR "driverId" = ${drv}::uuid)
      UNION ALL SELECT ("cancelledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Ulaanbaatar')::date, 0, 1, 0 FROM "Order"
        WHERE status = 'CANCELLED' AND "driverId" IS NOT NULL AND "cancelReason" IN ('DRIVER_CANCELLED', 'ISSUE') AND "cancelledAt" >= ${t0} AND "cancelledAt" < ${t1} AND (${drv}::uuid IS NULL OR "driverId" = ${drv}::uuid)
      UNION ALL SELECT ("postponedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Ulaanbaatar')::date, 0, 0, 1 FROM "Order"
        WHERE "postponedByDriverId" IS NOT NULL AND "postponedAt" >= ${t0} AND "postponedAt" < ${t1} AND (${drv}::uuid IS NULL OR "postponedByDriverId" = ${drv}::uuid)
    ) x GROUP BY day`;
  const m = new Map(rows.map((r) => [r.day, r]));
  const out = Array.from({ length: days }, (_, i) => {
    const d = addDays(from, i); const r = m.get(d);
    return { date: d, delivered: r?.delivered ?? 0, cancelled: r?.cancelled ?? 0, postponed: r?.postponed ?? 0, total: (r?.delivered ?? 0) + (r?.cancelled ?? 0) + (r?.postponed ?? 0) };
  });
  return { days, from, to: today, daily: out };
}

/**
 * Хуваарилагдаагүй «Шинэ» захиалгын сануулга (#124-4, эзний дүрэм: өнөөдөр үүссэн захиалга өнөөдөртөө заавал хуваарилагдана).
 *  • today = маргааш хүргэх, хуваарилагдаагүй (өнөөдрийн ажил); leftover = хүргэх өдөр нь өнөөдөр/өнгөрсөн, хуваарилагдаагүй (хоносон).
 *  • 🔴 бүх хуудсанд (ахлах жолооч, Админ, Супер админ): хоносон байвал үргэлж; тохиргооны цагаас (анх 21:00) хойш өнөөдрийнх үлдсэн бол.
 */
let alertCache: { at: number; v: { today: number; leftover: number } } | null = null;
export async function unassignedAlert(roles: string[]): Promise<{ today: number; leftover: number; late: boolean; hour: number } | null> {
  if (!roles.some((r) => ['SUPER_ADMIN', 'ADMIN', 'DRIVER_LEAD'].includes(r))) return null;
  if (!alertCache || Date.now() - alertCache.at > 30_000) {
    const today = dateOnly(ubDay()); const tomorrow = dateOnly(ubDay(new Date(), 1));
    const r = await db.$queryRaw<{ today: number; leftover: number }[]>`
      -- Аудит А11: «Хоносон» = өмнөх өдрүүдэд үүссэн (өнөөдөр үүссэн өнөөдрийн хүргэлт «өнөөдрийн ажил»-д)
      SELECT count(*) FILTER (WHERE "deliveryDate" = ${tomorrow}::date OR ("deliveryDate" = ${today}::date AND "createdAt" >= ${ubDayStart(ubDay())}))::int AS today,
             count(*) FILTER (WHERE "deliveryDate" < ${today}::date OR ("deliveryDate" = ${today}::date AND "createdAt" < ${ubDayStart(ubDay())}))::int AS leftover
      FROM "Order" WHERE status = 'NEW' AND "driverId" IS NULL AND "deliveryDate" <= ${tomorrow}::date`;
    alertCache = { at: Date.now(), v: { today: r[0]?.today ?? 0, leftover: r[0]?.leftover ?? 0 } };
  }
  const { assignHour } = await orderSettings();
  const hourNow = new Date(Date.now() + 8 * 3_600_000).getUTCHours();
  const late = hourNow >= assignHour;
  const v = alertCache.v;
  return v.leftover || (late && v.today) ? { ...v, late, hour: assignHour } : null;
}
export function bustUnassignedAlert() { alertCache = null; }
