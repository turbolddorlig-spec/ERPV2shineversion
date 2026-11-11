import { Prisma } from '@prisma/client';
import { db } from '../../db';
import { badRequest, conflict, forbidden, notFound } from '../../errors';
import { writeAudit } from '../../audit';
import { canAccount, canDrive, canManagePay } from '../../permissions';
import { dateOnly, ubDay, ymdOf, isYmd } from '../../ubdate';
import { inTx, type UserActor } from '../orders/core';
import { cleanYmd } from '../delivery/core';
import { computeDay, computeDriverDay, DEFAULT_RULES, MODE_LABEL, rulesFor, rulesText, type DriverDay, type PayMode, type SalaryRules } from './calc';

type Tx = Prisma.TransactionClient;

/**
 * Модуль 6 — тооцоо нийлэх (хуучин шиг, #82 2):
 *   жолооч «Тооцоо нийлэх»: Бэлэн + Данс + Өр = Авах дүн (сервер тооцно) → PENDING; хүлээгдэж байхад «Тооцоо буцаах».
 *   нягтлан «Баталгаажуулах»: дүнг дахин шалгаж COMPLETED, тооцооны хуулбар хадгалж өдөр түгжигдэнэ; «Өр» → компанийн өрийн бүртгэл.
 * Нягтлан гараар засах гүйцэтгэл, «Тооцоо хийсэн» тэмдэг; Супер админ: жолоочийн горим (тусгай / орон нутаг), цалингийн дүрэм.
 */
const assertAccount = (a: UserActor) => { if (!canAccount(a.roles)) throw forbidden('Энэ үйлдлийг нягтлан, админ хийнэ'); };
const assertDriver = (a: UserActor) => { if (!canDrive(a.roles)) throw forbidden('Энэ үйлдлийг жолооч хийнэ'); };

function cleanUuid(v: unknown): string {
  const s = String(v ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(s)) throw badRequest('Жолооч буруу');
  return s;
}
function cleanMoney(v: unknown, label: string, allowNegative = false): number {
  const n = v === '' || v === null || v === undefined ? 0 : Number(v);
  if (!Number.isInteger(n) || n > 1_000_000_000 || (!allowNegative && n < 0) || n < -1_000_000_000) throw badRequest(`${label} буруу`);
  return n;
}
async function driverName(tx: Tx | typeof db, id: string) {
  const u = await tx.user.findUnique({ where: { id }, select: { name: true, roles: true } });
  if (!u || !u.roles.includes('DRIVER')) throw notFound('Жолооч олдсонгүй');
  return u.name;
}
/** Тооцоо байхгүй бол ноорог мөр үүсгэнэ (гүйцэтгэл засах, «Тооцоо хийсэн» тэмдэгт) — түгжээтэй */
async function lockSettlement(tx: Tx, driverId: string, date: string, name: string) {
  await tx.$executeRaw`INSERT INTO "DriverSettlement" ("driverId", "driverName", date, "updatedAt") VALUES (${driverId}::uuid, ${name}, ${dateOnly(date)}::date, now()) ON CONFLICT ("driverId", date) DO NOTHING`;
  const r = await tx.$queryRaw<{ id: number }[]>`SELECT id FROM "DriverSettlement" WHERE "driverId" = ${driverId}::uuid AND date = ${dateOnly(date)}::date FOR UPDATE`;
  return tx.driverSettlement.findUniqueOrThrow({ where: { id: r[0]!.id } });
}
/** Жолооч илгээсэн тооцоог буцааж ноорог болгоно — нягтлан тоо өөрчлөхөд (дахин илгээнэ) */
export async function reopenPending(tx: Tx, driverId: string, date: string, actorName: string, reason: string) {
  const n = await tx.driverSettlement.updateMany({ where: { driverId, date: dateOnly(date), status: 'PENDING' }, data: { status: 'DRAFT', submittedAt: null, version: { increment: 1 } } });
  if (n.count) await writeAudit({ id: null, name: actorName }, 'settlement.reopened', 'DriverSettlement', `${driverId}:${date}`, { date, reason }, tx, ['money']);
}

// ───────────────────────── Нягтлан: өдрийн самбар ─────────────────────────

export interface BoardFilter { driverId?: string; status?: string; prepaid?: string }

export async function accountingDay(actor: UserActor, dateIn?: string, f: BoardFilter = {}) {
  assertAccount(actor);
  const date = dateIn && isYmd(dateIn) ? dateIn : ubDay();
  let rows = await computeDay(db, date);
  const rules = await rulesFor(db, date);
  // KPI нийт (шүүлтээс өмнө)
  const kpi = totals(rows);
  if (f.driverId) rows = rows.filter((r) => r.driverId === f.driverId);
  if (f.status === 'COMPLETED') rows = rows.filter((r) => r.settlement?.status === 'COMPLETED');
  else if (f.status === 'PENDING') rows = rows.filter((r) => r.settlement?.status === 'PENDING');
  else if (f.status === 'NONE') rows = rows.filter((r) => !r.settlement || r.settlement.status === 'DRAFT');
  if (f.prepaid === 'yes') rows = rows.filter((r) => r.prepaidCount > 0);
  else if (f.prepaid === 'no') rows = rows.filter((r) => r.prepaidCount === 0);
  const [payments, approvals] = await Promise.all([
    db.driverPayment.findMany({ where: { date: dateOnly(date) }, orderBy: { createdAt: 'desc' } }),
    db.driverApproval.findMany({ where: { date: dateOnly(date) } }),
  ]);
  return {
    date, canManagePay: canManagePay(actor.roles), rules, rulesText: rulesText(rules),
    kpi, filteredTotals: totals(rows), items: rows,
    payments: payments.map((p) => ({ ...p, date: ymdOf(p.date) })),
    approvals: approvals.map((a) => ({ driverId: a.driverId, approved: a.approved, note: a.note, byName: a.byName })),
  };
}

export function totals(rows: DriverDay[]) {
  const t = {
    drivers: rows.length, total: 0, delivered: 0, cancelled: 0, excluded: 0, postponed: 0, out: 0, notReceived: 0,
    deliveredAmount: 0, prepaidAmount: 0, prepaidCount: 0, cancelledAmount: 0, salary: 0, toReceive: 0, cash: 0, bank: 0, unpaid: 0, extraSale: 0,
    settled: { count: 0, cash: 0, bank: 0, debt: 0, total: 0 }, pendingCount: 0, noneCount: 0,
  };
  for (const r of rows) {
    t.total += r.total; t.delivered += r.delivered; t.cancelled += r.cancelled; t.excluded += r.excluded; t.postponed += r.postponed; t.out += r.out; t.notReceived += r.notReceived;
    t.deliveredAmount += r.deliveredAmount; t.prepaidAmount += r.prepaidAmount; t.prepaidCount += r.prepaidCount; t.cancelledAmount += r.cancelledAmount;
    t.salary += r.salary; t.toReceive += r.toReceive; t.cash += r.cash; t.bank += r.bank; t.unpaid += r.unpaid; t.extraSale += r.extraSale.amount;
    const s = r.settlement;
    if (s?.status === 'COMPLETED') { t.settled.count++; t.settled.cash += s.cashAmount; t.settled.bank += s.bankAmount; t.settled.debt += s.debtAmount; t.settled.total += s.cashAmount + s.bankAmount + s.debtAmount; }
    else if (s?.status === 'PENDING') t.pendingCount++;
    else t.noneCount++;
  }
  return t;
}

/** Жолоочийн дэлгэрэнгүй (нягтлан): тооцоо + падааны захиалгууд (тэмдэгтэй) + нэмэлт бараа + өр */
export async function accountingDriver(actor: UserActor, driverIdIn: unknown, dateIn: unknown) {
  assertAccount(actor);
  const driverId = cleanUuid(driverIdIn);
  const date = cleanYmd(dateIn);
  return driverDetail(driverId, date);
}

async function driverDetail(driverId: string, date: string) {
  const [day, rules] = await Promise.all([computeDriverDay(db, date, driverId), rulesFor(db, date)]);
  const orders = await db.$queryRaw<{
    id: number; number: string; status: string; phone: string; total: number; originalTotal: number | null; prepaid: boolean; deliveryPayment: string | null;
    cancelReason: string | null; cancelNote: string | null; issueFault: string | null; postponed: boolean; deliveredAt: Date | null; cancelledAt: Date | null;
    province: string; district: string | null; addressDetail: string; deliveredByName: string | null; cancelledByName: string | null; refused: number; version: number;
  }[]>`
    SELECT o.id, o.number, o.status::text AS status, o.phone, o.total, o."originalTotal", o.prepaid, o."deliveryPayment"::text AS "deliveryPayment",
           o."cancelReason"::text AS "cancelReason", o."cancelNote", o."issueFault"::text AS "issueFault", (ho."removedAt" IS NOT NULL) AS postponed,
           o."deliveredAt", o."cancelledAt", o.province, o.district, o."addressDetail", o."deliveredByName", o."cancelledByName", o.version,
           (SELECT coalesce(sum(l."refusedQty"), 0)::int FROM "OrderLine" l WHERE l."orderId" = o.id) AS refused
    FROM "Handover" h JOIN "HandoverOrder" ho ON ho."handoverId" = h.id JOIN "Order" o ON o.id = ho."orderId"
    WHERE h."driverId" = ${driverId}::uuid AND h.date = ${dateOnly(date)}::date
      AND (ho."removedAt" IS NULL AND o."handoverId" = h.id OR ho."removeReason" = 'Маргааш (бараа жолоочид)')
    ORDER BY ho.position`;
  const lines = orders.length ? await db.orderLine.findMany({ where: { orderId: { in: orders.map((o) => o.id) } }, orderBy: { id: 'asc' }, select: { orderId: true, name: true, label: true, qty: true, refusedQty: true, unitPrice: true } }) : [];
  const lm = new Map<number, typeof lines>();
  for (const l of lines) { const a = lm.get(l.orderId) ?? []; a.push(l); lm.set(l.orderId, a); }
  const [extras, debts, payments] = await Promise.all([
    db.driverDoc.findMany({ where: { driverId, kind: { in: ['EXTRA_TAKE', 'EXTRA_SALE'] }, OR: [{ date: dateOnly(date) }, { kind: 'EXTRA_SALE', createdAt: { gte: new Date(`${date}T00:00:00+08:00`), lt: new Date(Date.parse(`${date}T00:00:00+08:00`) + 86_400_000) } }] }, include: { lines: true }, orderBy: { createdAt: 'asc' } }),
    db.companyDebt.findMany({ where: { driverId, status: 'PENDING' }, orderBy: { createdAt: 'desc' }, take: 100 }),
    db.driverPayment.findMany({ where: { driverId, date: dateOnly(date) }, orderBy: { createdAt: 'desc' } }),
  ]);
  return {
    day, rules, rulesText: rulesText(rules), modeLabel: MODE_LABEL[day.mode],
    orders: orders.map((o) => ({ ...o, lines: lm.get(o.id) ?? [] })),
    extras: extras.map((d) => ({ id: d.id, kind: d.kind, status: d.status, total: d.total, payment: d.payment, createdAt: d.createdAt, lines: d.lines.map((l) => ({ variantId: l.variantId, qty: l.qty, unitPrice: l.unitPrice })) })),
    debts: debts.map((d) => ({ id: d.id, kind: d.kind, description: d.description, amount: d.amount, createdAt: d.createdAt })),
    debtTotal: debts.reduce((s, d) => s + d.amount, 0),
    payments: payments.map((p) => ({ ...p, date: ymdOf(p.date) })),
  };
}

// ───────────────────────── Жолооч: «Орлого» ─────────────────────────

export async function driverIncome(actor: UserActor, dateIn?: string) {
  assertDriver(actor);
  const date = dateIn && isYmd(dateIn) ? dateIn : ubDay();
  if (date > ubDay()) throw badRequest('Ирээдүйн өдөр');
  const d = await driverDetail(actor.id, date);
  const debt = await db.companyDebt.aggregate({ where: { driverId: actor.id, status: 'PENDING' }, _sum: { amount: true }, _count: true });
  return { date, today: ubDay(), ...d, companyDebt: { amount: debt._sum.amount ?? 0, count: debt._count } };
}

/** «Тооцоо нийлэх»: Бэлэн + Данс + Өр = Авах дүн (сервер тооцно, утсаас ирсэн дүнд итгэхгүй) */
export async function submitSettlement(actor: UserActor, input: { date?: unknown; cash?: unknown; bank?: unknown; debt?: unknown }) {
  assertDriver(actor);
  const date = cleanYmd(input.date);
  if (date > ubDay()) throw badRequest('Ирээдүйн өдрийн тооцоо илгээхгүй');
  const r = await inTx(async (tx) => {
    const s = await lockSettlement(tx, actor.id, date, actor.name);
    if (s.status === 'COMPLETED') throw conflict('Нягтлан баталгаажуулсан тооцоо — өөрчлөх боломжгүй', 'day_locked');
    const day = await computeDriverDay(tx, date, actor.id);
    if (!day.total && !day.handover) throw conflict('Энэ өдөр падаан байхгүй', 'no_handover');
    if (day.out || day.notReceived) throw conflict(`Дуусаагүй захиалга ${day.out + day.notReceived} байна — хүргэсэн / цуцалсан / маргааш болгосны дараа тооцоо нийлнэ`, 'unfinished');
    const neg = day.toReceive < 0;
    const cash = cleanMoney(input.cash, 'Бэлэн', neg);
    const bank = cleanMoney(input.bank, 'Данс');
    const debt = cleanMoney(input.debt, 'Өр');
    if (cash + bank + debt !== day.toReceive) throw badRequest(`Бэлэн + Данс + Өр = ${day.toReceive.toLocaleString('en-US')}₮ байх ёстой (одоо ${(cash + bank + debt).toLocaleString('en-US')}₮)`, 'sum_mismatch');
    const u = await tx.driverSettlement.update({
      where: { id: s.id },
      data: { status: 'PENDING', cashAmount: cash, bankAmount: bank, debtAmount: debt, expectedAmount: day.toReceive, submittedAt: new Date(), driverName: actor.name, version: { increment: 1 } },
    });
    await writeAudit(actor, 'settlement.submitted', 'DriverSettlement', String(s.id), { date, cash, bank, debt, expected: day.toReceive }, tx, ['money']);
    return u;
  });
  return { settlement: r };
}

/** «Тооцоо буцаах» — нягтлан баталгаажуулаагүй үед */
export async function withdrawSettlement(actor: UserActor, input: { date?: unknown }) {
  assertDriver(actor);
  const date = cleanYmd(input.date);
  return inTx(async (tx) => {
    const s = await tx.driverSettlement.findUnique({ where: { driverId_date: { driverId: actor.id, date: dateOnly(date) } } });
    if (!s || s.status === 'DRAFT') return { duplicate: true };
    if (s.status === 'COMPLETED') throw conflict('Нягтлан баталгаажуулсан тооцоог буцаах боломжгүй', 'day_locked');
    await tx.driverSettlement.update({ where: { id: s.id }, data: { status: 'DRAFT', submittedAt: null, cashAmount: 0, bankAmount: 0, debtAmount: 0, version: { increment: 1 } } });
    await writeAudit(actor, 'settlement.withdrawn', 'DriverSettlement', String(s.id), { date }, tx, ['money']);
    return { duplicate: false };
  });
}

/** Нягтлан «Баталгаажуулах» — буцаах боломжгүй; «Өр» хэсэг компанийн өрийн бүртгэлд */
export async function approveSettlement(actor: UserActor, idIn: unknown) {
  assertAccount(actor);
  const id = Number(idIn);
  if (!Number.isInteger(id) || id <= 0) throw notFound('Тооцоо олдсонгүй');
  let mismatch: { expected: number; now: number; driverId: string; date: string } | null = null;
  const r = await inTx(async (tx) => {
    const rows = await tx.$queryRaw<{ id: number }[]>`SELECT id FROM "DriverSettlement" WHERE id = ${id} FOR UPDATE`;
    if (!rows.length) throw notFound('Тооцоо олдсонгүй');
    const s = await tx.driverSettlement.findUniqueOrThrow({ where: { id } });
    if (s.status === 'COMPLETED') return { settlement: s, duplicate: true };
    if (s.status !== 'PENDING') throw conflict('Жолооч тооцоогоо илгээгээгүй байна', 'not_submitted');
    const date = ymdOf(s.date);
    const day = await computeDriverDay(tx, date, s.driverId);
    if (day.out || day.notReceived) throw conflict('Дуусаагүй захиалгатай — баталгаажуулах боломжгүй', 'unfinished');
    if (day.toReceive !== s.expectedAmount || s.cashAmount + s.bankAmount + s.debtAmount !== day.toReceive) {
      mismatch = { expected: s.expectedAmount, now: day.toReceive, driverId: s.driverId, date };
      return null;
    }
    const snapshot = { ...day, settlement: null, locked: true } as unknown as Prisma.InputJsonValue;
    const u = await tx.driverSettlement.update({ where: { id }, data: { status: 'COMPLETED', approvedAt: new Date(), approvedByName: actor.name, snapshot, version: { increment: 1 } } });
    if (s.debtAmount > 0) {
      await tx.companyDebt.create({ data: {
        driverId: s.driverId, driverName: s.driverName, kind: 'SETTLEMENT_DEBT', settlementId: id, amount: s.debtAmount, createdByName: actor.name, date: s.date,
        description: `Тооцоо нийлэхэд өр үүсгэсэн (${date}) — Бэлэн: ${s.cashAmount.toLocaleString('en-US')}₮, Данс: ${s.bankAmount.toLocaleString('en-US')}₮, Өр: ${s.debtAmount.toLocaleString('en-US')}₮`,
      } });
    }
    await writeAudit(actor, 'settlement.approved', 'DriverSettlement', String(id), { driver: s.driverName, date, cash: s.cashAmount, bank: s.bankAmount, debt: s.debtAmount, toReceive: day.toReceive, salary: day.salary }, tx, ['money']);
    return { settlement: u, duplicate: false };
  });
  if (mismatch) {
    const m = mismatch as { expected: number; now: number; driverId: string; date: string };
    await inTx((tx) => reopenPending(tx, m.driverId, m.date, actor.name, `Дүн өөрчлөгдсөн: ${m.expected} → ${m.now}`));
    throw conflict(`Жолоочийн илгээснээс хойш дүн өөрчлөгдсөн (${m.expected.toLocaleString('en-US')}₮ → ${m.now.toLocaleString('en-US')}₮) — жолооч дахин илгээнэ`, 'amount_changed');
  }
  return r!;
}

/** «Тооцоо хийсэн» тэмдэг (нягтлангийн дотоод тэмдэглэл) */
export async function setAccountingSettled(actor: UserActor, input: { driverId?: unknown; date?: unknown; value?: unknown }) {
  assertAccount(actor);
  const driverId = cleanUuid(input.driverId);
  const date = cleanYmd(input.date);
  const value = input.value === true;
  const name = await driverName(db, driverId);
  return inTx(async (tx) => {
    const s = await lockSettlement(tx, driverId, date, name);
    const u = await tx.driverSettlement.update({ where: { id: s.id }, data: { accountingSettled: value, settledAt: value ? new Date() : null, settledByName: value ? actor.name : null, version: { increment: 1 } } });
    await writeAudit(actor, 'settlement.marked', 'DriverSettlement', String(s.id), { driver: name, date, value }, tx, ['money']);
    return { settlement: u };
  });
}

/** «✏️ Засах» гүйцэтгэл (0–100, тайлбартай; хоосон = тооцоолсон руу буцаах). Зөвхөн тэр өдөрт, баталгаажсан өдөр түгжээтэй */
export async function setPerfOverride(actor: UserActor, input: { driverId?: unknown; date?: unknown; value?: unknown; note?: unknown }) {
  assertAccount(actor);
  const driverId = cleanUuid(input.driverId);
  const date = cleanYmd(input.date);
  const clear = input.value === null || input.value === '' || input.value === undefined;
  const value = clear ? null : Number(input.value);
  if (value !== null && (!Number.isFinite(value) || value < 0 || value > 100)) throw badRequest('Гүйцэтгэл 0–100 хооронд');
  const note = String(input.note ?? '').trim().slice(0, 300);
  if (!clear && note.length < 3) throw badRequest('Засах шалтгаанаа бичнэ үү', 'reason_required');
  const name = await driverName(db, driverId);
  return inTx(async (tx) => {
    const s = await lockSettlement(tx, driverId, date, name);
    if (s.status === 'COMPLETED') throw conflict('Баталгаажсан тооцоо — гүйцэтгэл өөрчлөх боломжгүй', 'day_locked');
    const before = s.perfOverride === null ? null : Number(s.perfOverride);
    await tx.driverSettlement.update({ where: { id: s.id }, data: clear
      ? { perfOverride: null, perfNote: null, perfByName: actor.name, perfAt: new Date(), version: { increment: 1 } }
      : { perfOverride: new Prisma.Decimal(Math.round(value! * 100) / 100), perfNote: note, perfByName: actor.name, perfAt: new Date(), version: { increment: 1 } } });
    await reopenPending(tx, driverId, date, actor.name, 'Гүйцэтгэл гараар засагдсан');
    await writeAudit(actor, 'settlement.perf_override', 'DriverSettlement', String(s.id), { driver: name, date, from: before, to: value, note: note || null }, tx, ['money']);
    return { day: await computeDriverDay(tx, date, driverId) };
  });
}

// ───────────────────────── Супер админ: горим ба цалингийн дүрэм ─────────────────────────

export async function payModes(actor: UserActor) {
  if (!canManagePay(actor.roles)) throw forbidden('«Гүйцэтгэл солих»-ийг Супер админ хийнэ');
  const today = ubDay();
  const drivers = await db.user.findMany({ where: { isActive: true, roles: { has: 'DRIVER' } }, select: { id: true, name: true, phone: true }, orderBy: { name: 'asc' } });
  const rows = await db.$queryRaw<{ driverId: string; mode: string; regionalRate: number | null; effectiveFrom: Date; byName: string }[]>`
    SELECT DISTINCT ON ("driverId") "driverId", mode, "regionalRate", "effectiveFrom", "byName" FROM "DriverPayMode"
    WHERE "effectiveFrom" <= ${dateOnly(today)}::date ORDER BY "driverId", "effectiveFrom" DESC`;
  const m = new Map(rows.map((r) => [r.driverId, r]));
  const rules = await rulesFor(db, today);
  return {
    regionalDefault: rules.regionalDefault,
    items: drivers.map((d) => {
      const r = m.get(d.id);
      const mode = (r?.mode ?? 'NORMAL') as PayMode;
      return { ...d, mode, modeLabel: MODE_LABEL[mode], regionalRate: r?.regionalRate ?? null, since: r ? ymdOf(r.effectiveFrom) : null, byName: r?.byName ?? null };
    }),
  };
}

/** Тусгай / Орон нутаг / Энгийн — ӨНӨӨДРӨӨС хүчинтэй (өнгөрсөн өдрийн тооцоо өөрчлөгдөхгүй) */
export async function setPayMode(actor: UserActor, input: { driverId?: unknown; mode?: unknown; rate?: unknown }) {
  if (!canManagePay(actor.roles)) throw forbidden('«Гүйцэтгэл солих»-ийг Супер админ хийнэ');
  const driverId = cleanUuid(input.driverId);
  const mode = String(input.mode ?? '') as PayMode;
  if (!(mode in MODE_LABEL)) throw badRequest('Горим буруу');
  let rate: number | null = null;
  if (mode === 'REGIONAL') {
    rate = input.rate === undefined || input.rate === '' || input.rate === null ? (await rulesFor(db, ubDay())).regionalDefault : Number(input.rate);
    if (!Number.isInteger(rate) || rate < 1000 || rate > 10000) throw badRequest('Орон нутгийн хөлс 1,000–10,000₮');
  }
  const name = await driverName(db, driverId);
  const today = ubDay();
  return inTx(async (tx) => {
    const done = await tx.driverSettlement.findUnique({ where: { driverId_date: { driverId, date: dateOnly(today) } }, select: { status: true } });
    if (done?.status === 'COMPLETED') throw conflict('Өнөөдрийн тооцоо баталгаажсан — маргаашаас өөрчлөгдөнө. Маргааш дахин оролдоно уу', 'day_locked');
    await tx.driverPayMode.upsert({
      where: { driverId_effectiveFrom: { driverId, effectiveFrom: dateOnly(today) } },
      create: { driverId, effectiveFrom: dateOnly(today), mode, regionalRate: rate, byName: actor.name },
      update: { mode, regionalRate: rate, byName: actor.name },
    });
    await reopenPending(tx, driverId, today, actor.name, 'Гүйцэтгэлийн горим солигдсон');
    await writeAudit(actor, 'driver.pay_mode', 'User', driverId, { driver: name, mode, rate, from: today }, tx, ['money']);
    return { ok: true, message: mode === 'NORMAL' ? `${name} энгийн гүйцэтгэл рүү буцлаа` : mode === 'SPECIAL' ? `${name} тусгай гүйцэтгэлтэй боллоо` : `${name} орон нутгийн гүйцэтгэлтэй боллоо (${rate!.toLocaleString('en-US')}₮)` };
  });
}

export async function salaryRules(actor: UserActor) {
  if (!canManagePay(actor.roles) && !canAccount(actor.roles)) throw forbidden();
  const today = ubDay();
  const [current, history] = await Promise.all([rulesFor(db, today), db.salaryRule.findMany({ orderBy: { effectiveFrom: 'desc' }, take: 50 })]);
  return { today, current, defaults: DEFAULT_RULES, canEdit: canManagePay(actor.roles), history: history.map((h) => ({ ...h, effectiveFrom: ymdOf(h.effectiveFrom) })) };
}

function cleanRules(v: unknown): SalaryRules {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, Record<string, unknown> | unknown>;
  const int = (x: unknown, label: string, max = 1_000_000) => { const n = Number(x); if (!Number.isInteger(n) || n < 0 || n > max) throw badRequest(`${label} буруу`); return n; };
  const pct = (x: unknown, label: string) => { const n = Number(x); if (!Number.isFinite(n) || n < 0 || n > 100) throw badRequest(`${label} 0–100 хооронд`); return Math.round(n * 100) / 100; };
  const tiers = (t: unknown, label: string) => {
    const x = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>;
    const r = { high: pct(x.high, `${label}: өндөр босго`), mid: pct(x.mid, `${label}: дунд босго`) };
    if (r.mid > r.high) throw badRequest(`${label}: дунд босго өндрөөс их байж болохгүй`);
    return r;
  };
  const rates = (o.rates && typeof o.rates === 'object' ? o.rates : {}) as Record<string, unknown>;
  const r: SalaryRules = {
    rates: { high: int(rates.high, 'Өндөр хөлс'), mid: int(rates.mid, 'Дунд хөлс'), low: int(rates.low, 'Бага хөлс') },
    regionalDefault: int(o.regionalDefault, 'Орон нутгийн анхны хөлс'),
    bigCount: int(o.bigCount, 'Захиалгын тооны босго', 1000),
    big: tiers(o.big, 'Олон захиалга'), small: tiers(o.small, 'Цөөн захиалга'), special: tiers(o.special, 'Тусгай'),
  };
  if (r.bigCount < 1) throw badRequest('Захиалгын тооны босго 1-ээс их');
  return r;
}

/** Цалингийн дүрэм солих — «хэдэн өдрөөс хүчинтэй» (өнөөдөр эсвэл хойш); тэр өдрөөс хойш баталгаажсан тооцоо байвал болохгүй */
export async function setSalaryRules(actor: UserActor, input: { effectiveFrom?: unknown; rules?: unknown; note?: unknown }) {
  if (!canManagePay(actor.roles)) throw forbidden('Цалингийн дүрмийг Супер админ өөрчилнө');
  const from = cleanYmd(input.effectiveFrom, 'Хүчинтэй өдөр');
  if (from < ubDay()) throw badRequest('Өнгөрсөн өдрөөс өөрчлөхгүй — өнгөрсөн тооцоо хэвээр үлдэнэ', 'past_date');
  const rules = cleanRules(input.rules);
  const note = String(input.note ?? '').trim().slice(0, 300) || null;
  return inTx(async (tx) => {
    const done = await tx.driverSettlement.count({ where: { date: { gte: dateOnly(from) }, status: 'COMPLETED' } });
    if (done) throw conflict(`${from}-ээс хойш баталгаажсан тооцоо ${done} байна — дараагийн өдрөөс сонгоно уу`, 'day_locked');
    const before = await rulesFor(tx, from);
    await tx.salaryRule.upsert({ where: { effectiveFrom: dateOnly(from) }, create: { effectiveFrom: dateOnly(from), rules: rules as unknown as Prisma.InputJsonValue, note, byName: actor.name }, update: { rules: rules as unknown as Prisma.InputJsonValue, note, byName: actor.name } });
    const pend = await tx.driverSettlement.findMany({ where: { date: { gte: dateOnly(from) }, status: 'PENDING' }, select: { driverId: true, date: true } });
    for (const p of pend) await reopenPending(tx, p.driverId, ymdOf(p.date), actor.name, 'Цалингийн дүрэм солигдсон');
    await writeAudit(actor, 'salary.rules', 'SalaryRule', from, { from, before: { ...before, effectiveFrom: undefined }, after: rules, note } as unknown as Prisma.InputJsonValue, tx, ['money', 'settings']);
    return { ok: true };
  });
}

// ───────────────────────── Урьдчилгаа, нэмэлт барааны тооцоо (хуучин шиг, Авах дүнд орохгүй) ─────────────────────────

export const PAYMENT_KIND_LABEL: Record<string, string> = { ADVANCE: 'Урьдчилгаа шилжүүлэх', EXTRA: 'Нэмэлт барааны тооцоо' };

export async function createDriverPayment(actor: UserActor, input: { kind?: unknown; date?: unknown; amount?: unknown; note?: unknown; idemKey?: unknown }) {
  assertDriver(actor);
  const kind = String(input.kind ?? '');
  if (!(kind in PAYMENT_KIND_LABEL)) throw badRequest('Төрөл буруу');
  const date = cleanYmd(input.date);
  if (date > ubDay()) throw badRequest('Ирээдүйн өдөр');
  const amount = Number(input.amount);
  if (!Number.isInteger(amount) || amount <= 0 || amount > 100_000_000) throw badRequest('Дүнгээ оруулна уу');
  const note = String(input.note ?? '').trim().slice(0, 300) || null;
  const idemKey = String(input.idemKey ?? '').slice(0, 80);
  if (idemKey.length < 8) throw badRequest('Хүсэлтийн түлхүүр буруу');
  const dup = await db.driverPayment.findUnique({ where: { idemKey } });
  if (dup) return { payment: dup, duplicate: true };
  return inTx(async (tx) => {
    const p = await tx.driverPayment.create({ data: { kind, driverId: actor.id, driverName: actor.name, date: dateOnly(date), amount, note, idemKey } });
    await writeAudit(actor, 'driver.payment_created', 'DriverPayment', String(p.id), { kind, date, amount, note }, tx, ['money']);
    return { payment: p, duplicate: false };
  });
}

/** Жолооч: зөвшөөрөгдөөгүй бичлэгээ устгах */
export async function deleteDriverPayment(actor: UserActor, idIn: unknown) {
  assertDriver(actor);
  const id = Number(idIn);
  return inTx(async (tx) => {
    const p = await tx.driverPayment.findUnique({ where: { id } });
    if (!p || p.driverId !== actor.id) throw notFound('Олдсонгүй');
    if (p.approved) throw conflict('Нягтлан зөвшөөрсөн — устгах боломжгүй', 'approved');
    await tx.driverPayment.delete({ where: { id } });
    await writeAudit(actor, 'driver.payment_deleted', 'DriverPayment', String(id), { kind: p.kind, amount: p.amount, date: ymdOf(p.date) }, tx, ['money']);
    return { ok: true };
  });
}

/** Нягтлан «Зөвшөөрөх» / буцаах */
export async function approveDriverPayment(actor: UserActor, idIn: unknown, input: { approved?: unknown }) {
  assertAccount(actor);
  const id = Number(idIn);
  const approved = input.approved === true;
  return inTx(async (tx) => {
    const p = await tx.driverPayment.findUnique({ where: { id } });
    if (!p) throw notFound('Олдсонгүй');
    const u = await tx.driverPayment.update({ where: { id }, data: { approved, approvedAt: approved ? new Date() : null, approvedByName: approved ? actor.name : null } });
    await writeAudit(actor, approved ? 'driver.payment_approved' : 'driver.payment_unapproved', 'DriverPayment', String(id), { driver: p.driverName, kind: p.kind, amount: p.amount, date: ymdOf(p.date) }, tx, ['money']);
    return { payment: u };
  });
}

// ───────────────────────── Нягтлан «Төлөв солих» (хуучин шиг, бараа журналаар — B2) ─────────────────────────

/**
 * Хүргэлтэд → Хүргэсэн / Цуцласан, Хүргэсэн → Цуцласан, Цуцласан → Хүргэсэн. Жолоочийн нэрийн өмнөөс (бараа жолооч ↔ үйлчлүүлэгч журналаар хөдөлнө,
 * агуулахад шууд хүрэхгүй). Захиалга падааныхаа өдөрт үлдэнэ (#83); баталгаажсан өдөр түгжээтэй; хүлээгдэж буй тооцоо ноорог болно (жолооч дахин илгээнэ).
 */
export async function toggleOrderStatus(actor: UserActor, idIn: unknown, input: { target?: unknown; note?: unknown; payment?: unknown; version?: unknown }) {
  assertAccount(actor);
  const id = Number(idIn);
  if (!Number.isInteger(id) || id <= 0) throw notFound('Захиалга олдсонгүй');
  const target = String(input.target ?? '');
  if (!['DELIVERED', 'CANCELLED'].includes(target)) throw badRequest('Шинэ төлвөө сонгоно уу');
  const noteRaw = String(input.note ?? '').trim();
  if (noteRaw.length < 3) throw badRequest('Төлөв солих шалтгаанаа бичнэ үү', 'reason_required');
  const note = `Нягтлан: ${noteRaw}`.slice(0, 500);
  const o = await db.order.findUnique({ where: { id }, select: { status: true, handoverId: true, driverId: true, prepaid: true, number: true } });
  if (!o) throw notFound('Захиалга олдсонгүй');
  if (!o.handoverId || !o.driverId) throw conflict('Падаангүй захиалгын төлвийг энд солихгүй', 'no_handover');
  const { deliverOrder, undoDelivery, driverCancel } = await import('../delivery/driver');
  const OB = { accountant: true } as const;
  const payment = o.prepaid ? 'PREPAID' : String(input.payment ?? 'CASH');
  let r: { order: { id: number; status: string } };
  if (o.status === 'OUT_FOR_DELIVERY' && target === 'DELIVERED') r = await deliverOrder(actor, id, { payment, note, version: input.version }, OB);
  else if (o.status === 'OUT_FOR_DELIVERY' && target === 'CANCELLED') r = await driverCancel(actor, id, { note, version: input.version }, OB);
  else if (o.status === 'DELIVERED' && target === 'CANCELLED') r = await undoDelivery(actor, id, { note, version: input.version }, OB);
  else if (o.status === 'CANCELLED' && target === 'DELIVERED') r = await deliverOrder(actor, id, { payment, note, version: input.version }, OB);
  else throw conflict('Энэ төлвөөс солих боломжгүй', 'bad_status');
  const h = await db.handover.findUnique({ where: { id: o.handoverId }, select: { driverId: true, date: true } });
  if (h) await inTx((tx) => reopenPending(tx, h.driverId, ymdOf(h.date), actor.name, `№${o.number} төлөв солигдсон`));
  await writeAudit(actor, 'accounting.status_toggle', 'Order', String(id), { number: o.number, from: o.status, to: target, note: noteRaw }, db, ['order', 'money', 'delivery']);
  return r;
}
