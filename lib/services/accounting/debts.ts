import type { CompanyDebtKind, Prisma } from '@prisma/client';
import { db } from '../../db';
import { badRequest, forbidden, notFound } from '../../errors';
import { writeAudit, SYSTEM_ACTOR } from '../../audit';
import { canAccount, canDrive } from '../../permissions';
import { dateOnly, ubDay, ubDayStart, ubHour, isYmd } from '../../ubdate';
import { inTx, type UserActor } from '../orders/core';
import { addDays } from '../delivery/core';
import { driverGoods } from '../delivery/driver';

type Tx = Prisma.TransactionClient;

/**
 * Модуль 6 — компанид өгөх өр («Төлбөр тооцооны бүртгэл», хуучин DriverDebtLedger).
 * Жолоочийн ХУВИЙН «Өрийн дэвтэр» (#79, үйлчлүүлэгчийн өр)-тэй огт холбоогүй.
 *
 * Дутуу бараа (#82 6): өдрийн эцэст (00:00) жолоочийн гарт буцаагаагүй бараа (хүргэлтэд яваа захиалгынхаас гадна) автоматаар өр болно —
 * бараа тус бүрт нэг мөр, системийн үнээр. Агуулахад буцааж өгөх (эсвэл нэмэлт бараагаар зарах, дахин хүргэх)-эд тоо нь буурч,
 * 0 болоход автоматаар хаагдана — жолоочийг хохироохгүй. Барааны журнал (B2) огт өөрчлөгдөхгүй, зөвхөн мөнгөн бүртгэл.
 */
export const DEBT_KIND_LABEL: Record<CompanyDebtKind, string> = {
  GOODS_NOT_RETURNED: 'Агуулахад бараа буцаагаагүй',
  PRODUCT_NOT_DELIVERED: 'Барааг хүлээлгэж өгөөгүй',
  ACCOUNTING_MISMATCH: 'Нягтлантай нийлээгүй',
  SETTLEMENT_DEBT: 'Тооцоо нийлэхэд үүссэн өр',
  OTHER: 'Бусад',
};
const assertAccount = (a: UserActor) => { if (!canAccount(a.roles)) throw forbidden('Өрийн бүртгэлийг нягтлан, админ хөтөлнө'); };
const SYS = SYSTEM_ACTOR;

function cleanUuid(v: unknown): string {
  const s = String(v ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(s)) throw badRequest('Жолооч буруу');
  return s;
}

function serialize(d: Prisma.CompanyDebtGetPayload<object>) {
  return { ...d, kindLabel: DEBT_KIND_LABEL[d.kind], auto: d.kind === 'GOODS_NOT_RETURNED' && d.variantId !== null };
}

/** Жолооч бүрийн нээлттэй өр (хамгийн их нь эхэнд) */
export async function debtBoard(actor: UserActor) {
  assertAccount(actor);
  const [drivers, sums] = await Promise.all([
    db.user.findMany({ where: { isActive: true, roles: { has: 'DRIVER' } }, select: { id: true, name: true, phone: true }, orderBy: { name: 'asc' } }),
    db.companyDebt.groupBy({ by: ['driverId'], where: { status: 'PENDING' }, _sum: { amount: true }, _count: true }),
  ]);
  const m = new Map(sums.map((s) => [s.driverId, s]));
  const items = drivers.map((d) => ({ ...d, pending: m.get(d.id)?._sum.amount ?? 0, count: m.get(d.id)?._count ?? 0 }))
    .sort((a, b) => b.pending - a.pending || a.name.localeCompare(b.name, 'mn'));
  return { items, total: items.reduce((s, i) => s + i.pending, 0) };
}

/** Нэг жолоочийн өрийн бүртгэл — нягтлан эсвэл тухайн жолооч өөрөө (зөвхөн харах) */
export async function driverDebtLedger(actor: UserActor, driverIdIn: unknown, p: { page?: number } = {}) {
  const driverId = cleanUuid(driverIdIn);
  if (!canAccount(actor.roles) && !(canDrive(actor.roles) && actor.id === driverId)) throw forbidden();
  const driver = await db.user.findUnique({ where: { id: driverId }, select: { id: true, name: true, phone: true } });
  if (!driver) throw notFound('Жолооч олдсонгүй');
  const page = Math.max(1, Math.floor(Number(p.page) || 1));
  const [pending, resolved, sums] = await Promise.all([
    db.companyDebt.findMany({ where: { driverId, status: 'PENDING' }, orderBy: { createdAt: 'desc' }, take: 500 }),
    db.companyDebt.findMany({ where: { driverId, status: 'RESOLVED' }, orderBy: { resolvedAt: 'desc' }, skip: (page - 1) * 50, take: 50 }),
    db.companyDebt.groupBy({ by: ['status'], where: { driverId }, _sum: { amount: true }, _count: true }),
  ]);
  const sum = (st: string) => sums.find((x) => x.status === st);
  return {
    driver, page,
    summary: { pending: sum('PENDING')?._sum.amount ?? 0, pendingCount: sum('PENDING')?._count ?? 0, resolved: sum('RESOLVED')?._sum.amount ?? 0, resolvedCount: sum('RESOLVED')?._count ?? 0 },
    pending: pending.map(serialize), resolved: resolved.map(serialize),
  };
}

export async function addDebt(actor: UserActor, input: { driverId?: unknown; kind?: unknown; description?: unknown; amount?: unknown; orderNumber?: unknown }) {
  assertAccount(actor);
  const driverId = cleanUuid(input.driverId);
  const kind = String(input.kind ?? '') as CompanyDebtKind;
  if (!(kind in DEBT_KIND_LABEL)) throw badRequest('Өрийн төрлөө сонгоно уу');
  if (kind === 'SETTLEMENT_DEBT') throw badRequest('«Тооцоо нийлэхэд үүссэн өр» нь тооцоо баталгаажуулахад автоматаар үүснэ');
  const description = String(input.description ?? '').trim().slice(0, 500);
  if (description.length < 3) throw badRequest('Тайлбараа бичнэ үү', 'reason_required');
  const amount = Number(input.amount);
  if (!Number.isInteger(amount) || amount <= 0 || amount > 100_000_000) throw badRequest('Дүн буруу');
  const orderNumber = String(input.orderNumber ?? '').trim().slice(0, 20) || null;
  const u = await db.user.findUnique({ where: { id: driverId }, select: { name: true, roles: true } });
  if (!u || !u.roles.includes('DRIVER')) throw notFound('Жолооч олдсонгүй');
  return inTx(async (tx) => {
    const d = await tx.companyDebt.create({ data: { driverId, driverName: u.name, kind, description, amount, orderNumber, createdByName: actor.name } });
    await writeAudit(actor, 'debt.added', 'CompanyDebt', String(d.id), { driver: u.name, kind, amount, description, orderNumber }, tx, ['money', 'debt']);
    return serialize(d);
  });
}

/** «Өр хасах» (хуучин шиг тайлбартай). Автомат дутуу барааны өрийг гараар хаавал бараа буцаагаагүй хэвээр — дараагийн өдрийн эцэст дахин үүсч болно */
export async function resolveDebt(actor: UserActor, idIn: unknown, input: { note?: unknown }) {
  assertAccount(actor);
  const id = Number(idIn);
  if (!Number.isInteger(id) || id <= 0) throw notFound('Өр олдсонгүй');
  const note = String(input.note ?? '').trim().slice(0, 500);
  if (note.length < 3) throw badRequest('Хасах шалтгаанаа бичнэ үү', 'reason_required');
  return inTx(async (tx) => {
    const n = await tx.companyDebt.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'RESOLVED', resolvedAt: new Date(), resolvedByName: actor.name, resolvedNote: note, version: { increment: 1 } } });
    const d = await tx.companyDebt.findUnique({ where: { id } });
    if (!d) throw notFound('Өр олдсонгүй');
    if (!n.count) return { debt: serialize(d), duplicate: true };
    await writeAudit(actor, 'debt.resolved', 'CompanyDebt', String(id), { driver: d.driverName, kind: d.kind, amount: d.amount, note }, tx, ['money', 'debt']);
    return { debt: serialize(d), duplicate: false };
  });
}

/** «Өнөөдөр өр тавьсан» / «Өнөөдөр өр төлсөн» (хуучин шиг) */
export async function dailyDebts(actor: UserActor, dateIn?: string) {
  assertAccount(actor);
  const date = dateIn && isYmd(dateIn) ? dateIn : ubDay();
  const from = ubDayStart(date); const to = ubDayStart(addDays(date, 1));
  const [created, resolved] = await Promise.all([
    db.companyDebt.findMany({ where: { createdAt: { gte: from, lt: to } }, orderBy: { createdAt: 'desc' }, take: 300 }),
    db.companyDebt.findMany({ where: { resolvedAt: { gte: from, lt: to }, status: 'RESOLVED' }, orderBy: { resolvedAt: 'desc' }, take: 300 }),
  ]);
  return {
    date,
    created: created.map(serialize), resolved: resolved.map(serialize),
    createdTotal: created.reduce((s, d) => s + d.amount, 0), resolvedTotal: resolved.reduce((s, d) => s + d.amount, 0),
  };
}

// ───────────────────────── Автомат дутуу бараа (#82 6) ─────────────────────────

async function priceAndLabel(tx: Tx | typeof db, variantIds: number[]) {
  const vs = await tx.productVariant.findMany({ where: { id: { in: variantIds } }, select: { id: true, code: true, color: true, size: true, priceOverride: true, product: { select: { name: true, price: true } } } });
  return new Map(vs.map((v) => [v.id, { price: v.priceOverride ?? v.product.price, label: `${v.product.name}${[v.color, v.size].filter(Boolean).length ? ` · ${[v.color, v.size].filter(Boolean).join(' / ')}` : ''} (${v.code})` }]));
}
const shortageText = (label: string, qty: number, date: string) => `Агуулахад буцаагаагүй: ${label} × ${qty}ш (${date}-ний эцэст)`;

/**
 * Өр = буцаах ёстой бараа. close = өдрийн эцэс (00:00-ийн дараах эхний ажил): тоог яг одоогийн буцаах бараагаар тохируулна (шинэ өр үүснэ / нэмэгдэнэ / буурна).
 * close биш (буцаалт хүлээн авах, нэмэлт бараа зарах, дахин хүргэх үед): зөвхөн БУУРУУЛНА — min(өр, одоогийн буцаах бараа); 0 → автоматаар хаагдана.
 */
export async function syncShortageDebts(tx: Tx, driverId: string, opts: { close?: string } = {}) {
  const [g, open] = await Promise.all([
    driverGoods(tx, driverId),
    tx.companyDebt.findMany({ where: { driverId, kind: 'GOODS_NOT_RETURNED', status: 'PENDING', variantId: { not: null } } }),
  ]);
  const openM = new Map(open.map((d) => [d.variantId!, d]));
  const variantIds = [...new Set([...g.returnable.keys(), ...openM.keys()])];
  if (!variantIds.length) return { created: 0, changed: 0, resolved: 0 };
  const info = await priceAndLabel(tx, variantIds);
  let created = 0, changed = 0, resolved = 0;
  const driver = opts.close ? await tx.user.findUnique({ where: { id: driverId }, select: { name: true } }) : null;
  for (const v of variantIds) {
    const have = g.returnable.get(v) ?? 0;
    const d = openM.get(v);
    const inf = info.get(v) ?? { price: 0, label: `#${v}` };
    const target = opts.close ? have : Math.min(d?.qty ?? 0, have);
    if (!d) {
      if (!opts.close || target <= 0) continue;
      const nd = await tx.companyDebt.create({ data: {
        driverId, driverName: driver?.name ?? '', kind: 'GOODS_NOT_RETURNED', description: shortageText(inf.label, target, opts.close),
        amount: target * inf.price, variantId: v, qty: target, unitPrice: inf.price, date: dateOnly(opts.close), createdByName: 'Автомат (өдрийн эцэс)',
      } });
      await writeAudit(SYS, 'debt.shortage_created', 'CompanyDebt', String(nd.id), { driver: nd.driverName, item: inf.label, qty: target, amount: nd.amount, date: opts.close }, tx, ['money', 'debt', 'stock']);
      created++;
      continue;
    }
    if (target === d.qty) continue;
    if (target <= 0) {
      await tx.companyDebt.update({ where: { id: d.id }, data: { status: 'RESOLVED', resolvedAt: new Date(), resolvedByName: 'Автомат', resolvedNote: 'Бараа агуулахад буцсан (эсвэл зарагдсан / хүргэгдсэн) — өр автоматаар хаагдлаа', version: { increment: 1 } } });
      await writeAudit(SYS, 'debt.shortage_resolved', 'CompanyDebt', String(d.id), { driver: d.driverName, item: inf.label, qty: d.qty, amount: d.amount }, tx, ['money', 'debt', 'stock']);
      resolved++;
    } else {
      const unit = d.unitPrice ?? inf.price;
      await tx.companyDebt.update({ where: { id: d.id }, data: { qty: target, amount: target * unit, description: shortageText(inf.label, target, opts.close ?? (d.date ? d.date.toISOString().slice(0, 10) : ubDay())), version: { increment: 1 } } });
      await writeAudit(SYS, 'debt.shortage_changed', 'CompanyDebt', String(d.id), { driver: d.driverName, item: inf.label, from: d.qty, to: target, amount: target * unit }, tx, ['money', 'debt', 'stock']);
      changed++;
    }
  }
  return { created, changed, resolved };
}

/** Өдрийн эцсийн автомат өр — өдөрт нэг удаа (арын ажил, олон апп байсан ч advisory lock + тэмдэглэлээр нэг л удаа) */
export async function closeDayShortages(now = new Date()): Promise<{ ran: boolean; skipped?: boolean; date?: string; created?: number; changed?: number; resolved?: number }> {
  const date = ubDay(now, -1);
  const KEY = 'm6.shortageClosedFor';
  const done = await db.appSetting.findUnique({ where: { key: KEY } });
  if (done && String(done.value) >= date) return { ran: false };
  // Хоцорсон (06:00-оос хойш) бол өнөөдрийн падааны барааг «өчигдрийн дутуу» гэж хуурамч өр бичихгүй — алгасаад анхааруулна (эзний шийдвэр)
  if (ubHour(now) >= SHORTAGE_LATE_HOUR) {
    // Анх суулгасан өдөр (өмнө нь нэг ч удаа хаагаагүй) — анхааруулгагүйгээр тэмдэглээд өнгөрнө
    if (!done) { await db.appSetting.create({ data: { key: KEY, value: date } }).catch(() => null); return { ran: false, date }; }
    await db.$transaction([
      db.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: date }, update: { value: date } }),
      db.appSetting.upsert({ where: { key: SHORTAGE_SKIP_KEY }, create: { key: SHORTAGE_SKIP_KEY, value: { date, at: now.toISOString() } }, update: { value: { date, at: now.toISOString() } } }),
    ]);
    await writeAudit(SYSTEM_ACTOR, 'debt.shortage_skipped', 'CompanyDebt', null, { date, at: now.toISOString(), reason: `Арын ажил ${String(SHORTAGE_LATE_HOUR).padStart(2, '0')}:00-оос хойш ажилласан` }, db, ['money', 'debt', 'alert']);
    skipCache = null;
    return { ran: false, skipped: true, date };
  }
  const drivers = await db.$queryRaw<{ userId: string }[]>`
    SELECT DISTINCT l."userId" FROM "StockLocation" l JOIN "StockBalance" b ON b."locationId" = l.id
    WHERE l.kind = 'DRIVER' AND b.qty > 0 AND l."userId" IS NOT NULL
    UNION SELECT DISTINCT "driverId" FROM "CompanyDebt" WHERE kind = 'GOODS_NOT_RETURNED' AND status = 'PENDING'`;
  let created = 0, changed = 0, resolved = 0;
  for (const d of drivers) {
    const r = await inTx(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(3::int4, 0::int4)`;
      return syncShortageDebts(tx, d.userId, { close: date });
    });
    created += r.created; changed += r.changed; resolved += r.resolved;
  }
  await db.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: date }, update: { value: date } });
  // Дараагийн амжилттай хаалт өмнөх «алгассан» анхааруулгыг арилгана
  await db.appSetting.deleteMany({ where: { key: SHORTAGE_SKIP_KEY } });
  skipCache = null;
  return { ran: true, date, created, changed, resolved };
}

const SHORTAGE_LATE_HOUR = 6;
const SHORTAGE_SKIP_KEY = 'm6.shortageSkipped';
let skipCache: { at: number; v: { date: string; at: string } | null } | null = null;
/** Супер админ, нягтланд: шөнийн автомат өр хоцорсон тул бичигдээгүй өдөр */
export async function shortageSkipAlert(roles: string[]): Promise<{ date: string; at: string } | null> {
  if (!roles.some((r) => r === 'SUPER_ADMIN' || r === 'ACCOUNTING')) return null;
  if (!skipCache || Date.now() - skipCache.at > 30_000) {
    const row = await db.appSetting.findUnique({ where: { key: SHORTAGE_SKIP_KEY } });
    skipCache = { at: Date.now(), v: (row?.value ?? null) as { date: string; at: string } | null };
  }
  return skipCache.v;
}

/** Тест / нягтлан гараар: «Өдрийн эцсийн өр бодох» (тухайн жолоочид) */
export async function closeShortagesNow(actor: UserActor, driverIdIn: unknown) {
  assertAccount(actor);
  const driverId = cleanUuid(driverIdIn);
  return inTx(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(3::int4, 0::int4)`;
    return syncShortageDebts(tx, driverId, { close: ubDay() });
  });
}

/** Нээлттэй өрийн нийлбэр (OKEY шийдэхэд) */
export async function pendingDebtTotals(tx: Tx | typeof db, driverIds: string[]) {
  if (!driverIds.length) return new Map<string, number>();
  const rows = await tx.companyDebt.groupBy({ by: ['driverId'], where: { driverId: { in: driverIds }, status: 'PENDING' }, _sum: { amount: true } });
  return new Map(rows.map((r) => [r.driverId, r._sum.amount ?? 0]));
}


