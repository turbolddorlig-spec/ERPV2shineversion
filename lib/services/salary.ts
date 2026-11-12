import type { PenaltyType, Prisma, Role } from '@prisma/client';
import { db } from '../db';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors';
import { writeAudit } from '../audit';
import { canEdit } from '../permissions';
import { ROLE_LABEL } from '../roles';
import { dateOnly, isYmd, ubDayStart, ymdOf } from '../ubdate';
import { hashPassword, verifyPassword } from '../password';
import { addDays } from './delivery/core';
import { chargeLoanTx } from './stock/loans';
import { evaluationSalary } from './outflow';
import type { UserActor } from './users';

type Tx = Prisma.TransactionClient;

/**
 * Модуль 7б — Ажилтны цалин (#93), ХУУЧИН логикоор:
 *   хагас сар (1–15, 16–сүүл); Тогтмол (1 өдрийн цалин × ажилласан өдөр) эсвэл Захиалгаар (тухайн хугацаанд авсан, хүргэгдсэн захиалга × хөлс);
 *   урамшуулал + нэмэлт − суутгал − хассан торгууль − өрийн төлөлт − зээлсэн бараа = шилжүүлэх цалин.
 * Сайжруулалт: тооцоог сервер хийнэ; цоожлоход торгууль («хассан»), зээл («цалингаас суутгасан»), өрийн төлөлт ХЭРЭГЖИНЭ (давхардахгүй),
 * цоож тайлахад торгууль, өр буцна (зээл барааны хөдөлгөөнтэй тул хэвээр); цоожны кодыг Супер админ тохируулна (hash).
 */
const KEY_CODE = 'salary.lockCode';
/** Маркетингийн үнэлгээний цалин — сервер автоматаар нэмнэ (#104) */
export const EVAL_LABEL = 'Үнэлгээний цалин (автомат)';
const EXCLUDED_ROLES: Role[] = ['DRIVER', 'DRIVER_LEAD', 'SUPER_ADMIN', 'SUPPLIER'];
const ROLE_PENALTY: Partial<Record<Role, PenaltyType>> = { OPERATOR: 'OPP_ERROR', OPERATOR_LEAD: 'OPP_ERROR', MARKETING: 'MARKETING_ERROR', MARKETING_LEAD: 'MARKETING_ERROR', WAREHOUSE: 'WAREHOUSE_ERROR' };
export const DAY_TYPE_LABEL: Record<string, string> = { LEAVE: 'Чөлөөтэй', SICK: 'Өвчтэй', ABSENT: 'Тасалсан', DAY_OFF: 'Амарсан' };

const assert = (a: UserActor) => { if (!canEdit(a.roles, 'salary')) throw forbidden('Ажилтны цалинг Супер админ, Админ, Нягтлан хөтөлнө'); };
const isSA = (a: UserActor) => a.roles.includes('SUPER_ADMIN');
const money = (n: number) => `${n.toLocaleString('en-US')}₮`;
const cleanInt = (v: unknown, label: string, max = 1_000_000_000) => { const n = v === '' || v === null || v === undefined ? 0 : Number(v); if (!Number.isInteger(n) || n < 0 || n > max) throw badRequest(`${label} буруу`); return n; };

export interface Period { start: string; end: string; label: string; half: 1 | 2; ym: string; daysInMonth: number }
export function periodOf(ym: string, half: number): Period {
  if (!/^\d{4}-\d{2}$/.test(ym) || (half !== 1 && half !== 2)) throw badRequest('Хугацаа буруу');
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const start = half === 1 ? `${ym}-01` : `${ym}-16`;
  const end = half === 1 ? `${ym}-15` : `${ym}-${String(days).padStart(2, '0')}`;
  return { start, end, half, ym, daysInMonth: days, label: `${y}.${String(m).padStart(2, '0')} ${half === 1 ? '1–15' : `16–${days}`}` };
}
const periodOfDate = (d: Date) => { const s = ymdOf(d); return periodOf(s.slice(0, 7), Number(s.slice(8)) <= 15 ? 1 : 2); };

interface Staff { key: string; userId: string | null; externalId: number | null; name: string; role: string; roleLabel: string; roles: Role[]; external: boolean; jobTitle?: string }
async function staffOf(tx: Tx | typeof db, key: string): Promise<Staff> {
  if (key.startsWith('u:')) {
    const id = key.slice(2);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw badRequest('Ажилтан буруу');
    const u = await tx.user.findUnique({ where: { id }, select: { id: true, name: true, roles: true } });
    if (!u) throw notFound('Ажилтан олдсонгүй');
    const role = u.roles.find((r) => !EXCLUDED_ROLES.includes(r)) ?? u.roles[0]!;
    return { key, userId: u.id, externalId: null, name: u.name, role, roleLabel: u.roles.map((r) => ROLE_LABEL[r]).join(', '), roles: u.roles, external: false };
  }
  if (key.startsWith('x:')) {
    const id = Number(key.slice(2));
    const x = Number.isInteger(id) ? await tx.externalStaff.findUnique({ where: { id } }) : null;
    if (!x) throw notFound('Ажилтан олдсонгүй');
    return { key, userId: null, externalId: x.id, name: x.name, role: 'EXTERNAL', roleLabel: `Гадны · ${x.jobTitle}`, roles: [], external: true, jobTitle: x.jobTitle };
  }
  throw badRequest('Ажилтан буруу');
}

// ───────────────────────── Самбар ─────────────────────────

export async function salaryBoard(actor: UserActor, ymIn?: string) {
  assert(actor);
  const ym = ymIn && /^\d{4}-\d{2}$/.test(ymIn) ? ymIn : ymdOf(new Date(Date.now() + 8 * 3600_000)).slice(0, 7);
  const p1 = periodOf(ym, 1); const p2 = periodOf(ym, 2);
  // Аудит Б18: ажлаас гарсан (идэвхгүй) ч нээлттэй зээл, өр, хасагдаагүй торгууль, түгжээгүй цалинтай бол самбарт (саарал) үлдэнэ
  const [loanIds, debtKeys, penIds, recKeys] = await Promise.all([
    db.staffLoan.findMany({ where: { status: 'ISSUED' }, select: { staffId: true }, distinct: ['staffId'] }),
    db.staffDebt.findMany({ where: { isActive: true, staffKey: { startsWith: 'u:' } }, select: { staffKey: true }, distinct: ['staffKey'] }),
    db.penalty.findMany({ where: { status: 'ACTIVE', deducted: false }, select: { userId: true }, distinct: ['userId'] }),
    db.staffSalaryRecord.findMany({ where: { isLocked: false, staffKey: { startsWith: 'u:' } }, select: { staffKey: true }, distinct: ['staffKey'] }),
  ]);
  const pendingIds = [...new Set([...loanIds.map((x) => x.staffId), ...debtKeys.map((x) => x.staffKey.slice(2)), ...penIds.map((x) => x.userId), ...recKeys.map((x) => x.staffKey.slice(2))])];
  const [users, externals, configs, records, drvPen] = await Promise.all([
    db.user.findMany({ where: { OR: [{ isActive: true }, { isActive: false, id: { in: pendingIds } }], NOT: { roles: { hasSome: EXCLUDED_ROLES } } }, select: { id: true, name: true, roles: true, phone: true, isActive: true }, orderBy: { name: 'asc' } }),
    db.externalStaff.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } }),
    db.staffSalaryConfig.findMany(),
    db.staffSalaryRecord.findMany({ where: { periodStart: { in: [dateOnly(p1.start), dateOnly(p2.start)] } } }),
    db.penalty.groupBy({ by: ['userId', 'userName'], where: { type: 'DELIVERY_ERROR', status: 'ACTIVE', createdAt: { gte: ubDayStart(p1.start), lt: ubDayStart(addDays(p2.end, 1)) } }, _sum: { amount: true, deductedAmount: true }, _count: true }),
  ]);
  const cm = new Map(configs.map((c) => [c.userId, c]));
  const rm = new Map(records.map((r) => [`${r.staffKey}|${ymdOf(r.periodStart)}`, r]));
  const row = (key: string, base: { name: string; roleLabel: string; role: string; external: boolean; configured: boolean; salaryType: string; baseSalary: number; phone?: string; inactive?: boolean }) => ({
    key, ...base,
    periods: [p1, p2].map((p) => { const r = rm.get(`${key}|${p.start}`); return r ? { id: r.id, transferSalary: r.transferSalary, transferred: r.transferred, isLocked: r.isLocked, orderCount: r.orderCount, totalDeductions: r.totalDeductions + r.loanTotal + r.debtTotal, penaltyDeducted: r.penaltyDeducted } : null; }),
  });
  const rows = [
    ...users.map((u) => { const c = cm.get(u.id); const role = u.roles.find((r) => !EXCLUDED_ROLES.includes(r)) ?? u.roles[0]!; return row(`u:${u.id}`, { name: u.name, phone: u.phone, role, roleLabel: u.roles.map((r) => ROLE_LABEL[r]).join(', ') + (u.isActive ? '' : ' · Идэвхгүй (тооцоо дутуу)'), external: false, configured: !!c, salaryType: c?.salaryType ?? 'FIXED', baseSalary: c?.baseSalary ?? 0, inactive: !u.isActive }); }),
    ...externals.map((x) => row(`x:${x.id}`, { name: x.name, role: 'EXTERNAL', roleLabel: `Гадны · ${x.jobTitle}`, external: true, configured: true, salaryType: 'FIXED', baseSalary: x.baseSalary })),
  ];
  const tot = (i: 0 | 1) => rows.reduce((s, r) => s + (r.periods[i]?.transferSalary ?? 0), 0);
  return {
    ym, periods: [p1, p2], rows,
    totals: { p1: tot(0), p2: tot(1), all: tot(0) + tot(1), transferred: records.filter((r) => r.transferred).reduce((s, r) => s + r.transferSalary, 0) },
    driverPenalties: drvPen.map((d) => ({ userId: d.userId, name: d.userName, count: d._count, amount: d._sum.amount ?? 0, deducted: d._sum.deductedAmount ?? 0 })).sort((a, b) => b.amount - a.amount),
    hasLockCode: !!(await db.appSetting.findUnique({ where: { key: KEY_CODE } })), isSuperAdmin: isSA(actor),
  };
}

// ───────────────────────── Тохиргоо, гадны ажилтан, ажлын хуваарь ─────────────────────────

export async function setConfig(actor: UserActor, input: Record<string, unknown>) {
  assert(actor);
  const st = await staffOf(db, String(input.staffKey ?? ''));
  const salaryType = String(input.salaryType ?? 'FIXED');
  if (!['FIXED', 'ORDER_BASED'].includes(salaryType)) throw badRequest('Цалин бодох төрөл буруу');
  const v = { baseSalary: cleanInt(input.baseSalary, 'Үндсэн цалин'), bonusSalary: cleanInt(input.bonusSalary, 'Урамшуулал'), oppRatePerOrder: cleanInt(input.oppRatePerOrder, '1 захиалгын хөлс', 1_000_000), dailyRate: cleanInt(input.dailyRate, '1 өдрийн цалин', 10_000_000) };
  const bankName = String(input.bankName ?? '').trim().slice(0, 60); const bankAccount = String(input.bankAccount ?? '').trim().slice(0, 40);
  if (st.external) {
    const x = await db.externalStaff.update({ where: { id: st.externalId! }, data: { baseSalary: v.baseSalary, bankName, bankAccount, ...(input.name ? { name: String(input.name).trim().slice(0, 80) } : {}), ...(input.jobTitle ? { jobTitle: String(input.jobTitle).trim().slice(0, 80) } : {}) } });
    await writeAudit(actor, 'salary.external_updated', 'ExternalStaff', String(x.id), { name: x.name, baseSalary: x.baseSalary }, db, ['salary', 'money']);
    return { ok: true };
  }
  const before = await db.staffSalaryConfig.findUnique({ where: { userId: st.userId! } });
  await db.staffSalaryConfig.upsert({ where: { userId: st.userId! }, create: { userId: st.userId!, salaryType, ...v, bankName, bankAccount, updatedByName: actor.name }, update: { salaryType, ...v, bankName, bankAccount, updatedByName: actor.name } });
  await writeAudit(actor, 'salary.config', 'User', st.userId!, { staff: st.name, salaryType, ...v, bankName, from: before ? { salaryType: before.salaryType, baseSalary: before.baseSalary, bonusSalary: before.bonusSalary, oppRatePerOrder: before.oppRatePerOrder, dailyRate: before.dailyRate } : null }, db, ['salary', 'money']);
  return { ok: true };
}
export async function getConfig(actor: UserActor, staffKey: unknown) {
  assert(actor);
  const st = await staffOf(db, String(staffKey ?? ''));
  if (st.external) { const x = (await db.externalStaff.findUnique({ where: { id: st.externalId! } }))!; return { staff: st, config: { salaryType: 'FIXED', baseSalary: x.baseSalary, bonusSalary: 0, oppRatePerOrder: 0, dailyRate: 0, bankName: x.bankName, bankAccount: x.bankAccount } }; }
  const c = await db.staffSalaryConfig.findUnique({ where: { userId: st.userId! } });
  return { staff: st, config: c ?? { salaryType: 'FIXED', baseSalary: 0, bonusSalary: 0, oppRatePerOrder: 0, dailyRate: 0, bankName: '', bankAccount: '' } };
}

export async function addExternal(actor: UserActor, input: { name?: unknown; jobTitle?: unknown; baseSalary?: unknown }) {
  assert(actor);
  const name = String(input.name ?? '').trim().slice(0, 80); const jobTitle = String(input.jobTitle ?? '').trim().slice(0, 80);
  if (name.length < 2 || jobTitle.length < 2) throw badRequest('Нэр, албан тушаалаа бичнэ үү');
  const x = await db.externalStaff.create({ data: { name, jobTitle, baseSalary: cleanInt(input.baseSalary, 'Үндсэн цалин') } });
  await writeAudit(actor, 'salary.external_added', 'ExternalStaff', String(x.id), { name, jobTitle, baseSalary: x.baseSalary }, db, ['salary']);
  return x;
}
export async function removeExternal(actor: UserActor, idIn: unknown) {
  assert(actor);
  const x = await db.externalStaff.update({ where: { id: Number(idIn) }, data: { isActive: false } }).catch(() => { throw notFound('Ажилтан олдсонгүй'); });
  await writeAudit(actor, 'salary.external_removed', 'ExternalStaff', String(x.id), { name: x.name }, db, ['salary']);
  return { ok: true };
}

export async function workSchedule(actor: UserActor, ymIn: unknown) {
  assert(actor);
  const ym = String(ymIn ?? '');
  const p1 = periodOf(ym, 1); const p2 = periodOf(ym, 2);
  const days = await db.staffWorkDay.findMany({ where: { date: { gte: dateOnly(p1.start), lte: dateOnly(p2.end) } } });
  return { ym, daysInMonth: p2.daysInMonth, labels: DAY_TYPE_LABEL, days: days.map((d) => ({ staffKey: d.staffKey, date: ymdOf(d.date), dayType: d.dayType, note: d.note })) };
}
/** Өдөр тэмдэглэх: dayType хоосон = ажилласан (устгана) */
export async function setWorkDay(actor: UserActor, input: { staffKey?: unknown; date?: unknown; dayType?: unknown; note?: unknown }) {
  assert(actor);
  const st = await staffOf(db, String(input.staffKey ?? ''));
  const date = String(input.date ?? '');
  if (!isYmd(date)) throw badRequest('Огноо буруу');
  const dayType = String(input.dayType ?? '');
  const p = periodOfDate(dateOnly(date));
  const locked = await db.staffSalaryRecord.findFirst({ where: { staffKey: st.key, periodStart: dateOnly(p.start), isLocked: true }, select: { id: true } });
  if (locked) throw conflict('Энэ хугацааны цалин цоожтой — ажлын хуваарь засахгүй', 'locked');
  if (!dayType) await db.staffWorkDay.deleteMany({ where: { staffKey: st.key, date: dateOnly(date) } });
  else {
    if (!(dayType in DAY_TYPE_LABEL)) throw badRequest('Төрөл буруу');
    const note = String(input.note ?? '').trim().slice(0, 200) || null;
    await db.staffWorkDay.upsert({ where: { staffKey_date: { staffKey: st.key, date: dateOnly(date) } }, create: { staffKey: st.key, date: dateOnly(date), dayType, note, byName: actor.name }, update: { dayType, note, byName: actor.name } });
  }
  await writeAudit(actor, 'salary.work_day', 'StaffWorkDay', `${st.key}:${date}`, { staff: st.name, date, dayType: dayType || 'WORK' }, db, ['salary']);
  return { ok: true };
}

// ───────────────────────── Цалин бодох ─────────────────────────

interface Line { label: string; amount: number }
function cleanLines(v: unknown, label: string): Line[] {
  const arr = Array.isArray(v) ? v : [];
  return arr.slice(0, 30).map((x) => {
    const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    return { label: String(o.label ?? '').trim().slice(0, 120) || label, amount: cleanInt(o.amount, label) };
  }).filter((x) => x.amount > 0);
}

/** Тухайн хугацааны автомат утгууд (ажлын хуваарь, захиалга, торгууль, зээл, өр) */
async function computeInputs(tx: Tx | typeof db, st: Staff, p: Period) {
  const cfg = st.external
    ? await tx.externalStaff.findUnique({ where: { id: st.externalId! } }).then((x) => ({ salaryType: 'FIXED', baseSalary: x!.baseSalary, bonusSalary: 0, oppRatePerOrder: 0, dailyRate: 0, bankName: x!.bankName, bankAccount: x!.bankAccount }))
    : (await tx.staffSalaryConfig.findUnique({ where: { userId: st.userId! } })) ?? { salaryType: 'FIXED', baseSalary: 0, bonusSalary: 0, oppRatePerOrder: 0, dailyRate: 0, bankName: '', bankAccount: '' };
  const totalDays = Number(p.end.slice(8)) - Number(p.start.slice(8)) + 1;
  const off = await tx.staffWorkDay.groupBy({ by: ['dayType'], where: { staffKey: st.key, date: { gte: dateOnly(p.start), lte: dateOnly(p.end) } }, _count: true });
  const offDays = Object.fromEntries(off.map((o) => [o.dayType, o._count])) as Record<string, number>;
  const workingDays = totalDays - Object.values(offDays).reduce((s, n) => s + n, 0);
  const dailyRate = cfg.dailyRate > 0 ? cfg.dailyRate : Math.round(cfg.baseSalary / p.daysInMonth);
  const calcBase = Math.round((cfg.dailyRate > 0 ? cfg.dailyRate : cfg.baseSalary / p.daysInMonth) * workingDays);
  const isOpp = st.roles.some((r) => r === 'OPERATOR' || r === 'OPERATOR_LEAD');
  let orderCount = 0;
  if (!st.external && cfg.salaryType === 'ORDER_BASED' && isOpp) {
    // Хуучин шиг: тухайн хугацаанд АВСАН (үүссэн), хүргэгдсэн эсвэл мөнгө орсон захиалга — ажилтны дугаараар
    // Хуучин шиг (#102): захиалгын «өдөр» = баталгаажсан мөч (энгийн — үүссэн; урьдчилж төлсөн — мөнгө орсон)
    // Товлосон захиалга (#124 ялгаа 3): «Шинэ» болсон өдрөөр (хүргэхийн өмнөх өдөр) — тоолох өдөр = max(авсан өдөр, хүргэх өдөр − 1)
    const r = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "Order" o
      WHERE o."operatorId" = ${st.userId!}::uuid
        AND o."confirmedAt" >= ${ubDayStart(addDays(p.start, -130))} AND o."confirmedAt" < ${ubDayStart(addDays(p.end, 1))}
        AND (o.status = 'DELIVERED' OR (o.prepaid AND o.status IN ('NEW', 'ASSIGNED', 'OUT_FOR_DELIVERY')))
        -- жолооч «Маргааш» дарсан бол хүргэх өдөр нь шилжсэн тул авсан өдрөөр
        AND (CASE WHEN o."postponeCount" > 0 THEN (o."confirmedAt" + interval '8 hours')::date
                  ELSE GREATEST((o."confirmedAt" + interval '8 hours')::date, o."deliveryDate" - 1) END) BETWEEN ${dateOnly(p.start)}::date AND ${dateOnly(p.end)}::date`;
    orderCount = r[0]?.n ?? 0;
  }
  // Торгууль: хасагдаагүй үлдэгдэл (энэ хугацаа + өмнөхөөс үлдсэн), ролын төрлөөр; «Хаяг тодорхойгүй» хасна (хуучин шиг)
  const ptype = st.external ? null : st.roles.map((r) => ROLE_PENALTY[r]).find(Boolean) ?? null;
  const pens = st.external ? [] : await tx.penalty.findMany({ where: { userId: st.userId!, status: 'ACTIVE', deducted: false, createdAt: { lt: ubDayStart(addDays(p.end, 1)) }, ...(ptype ? { type: ptype } : {}) }, orderBy: { createdAt: 'asc' } });
  const penalties = pens.filter((x) => !/хаяг тодорхойгүй/i.test(`${x.category} ${x.description ?? ''}`)).map((x) => ({ id: x.id, category: x.category, createdAt: x.createdAt, amount: x.amount, remaining: x.amount - x.deductedAmount }));
  // Зээлсэн бараа: олгосон, буцаагаагүй (хөнгөлөлттэй үнээр)
  const loans = st.external ? [] : (await tx.staffLoan.findMany({ where: { staffId: st.userId!, status: 'ISSUED' }, include: { lines: true }, orderBy: { issuedAt: 'asc' } }))
    .map((l) => { const open = l.lines.map((x) => ({ q: x.qty - x.returnedQty - x.chargedQty, d: x.deduction ?? 0 })).filter((x) => x.q > 0); return { id: l.id, issuedAt: l.issuedAt, pieces: open.reduce((s, x) => s + x.q, 0), amount: open.reduce((s, x) => s + x.q * x.d, 0), note: l.note }; })
    .filter((l) => l.pieces > 0);
  const debts = (await tx.staffDebt.findMany({ where: { staffKey: st.key, isActive: true }, orderBy: { createdAt: 'asc' } })).map((d) => ({ id: d.id, description: d.description, totalAmount: d.totalAmount, remainingAmount: d.remainingAmount }));
  // Модуль 7г (#104): маркетингийн үнэлгээний цалин — «Нэмэлт орлого»-д автоматаар (давхардахгүй)
  const evalSalary = st.external || !st.roles.some((r) => r === 'MARKETING' || r === 'MARKETING_LEAD') ? 0 : await evaluationSalary(tx, st.userId!, p.start, p.end);
  return { cfg, isOpp, totalDays, workingDays, offDays, dailyRate, calcBase, orderCount, penalties, loans, debts, evalSalary };
}

export async function prepareSalary(actor: UserActor, staffKeyIn: unknown, ymIn: unknown, halfIn: unknown) {
  assert(actor);
  const st = await staffOf(db, String(staffKeyIn ?? ''));
  const p = periodOf(String(ymIn ?? ''), Number(halfIn));
  const [inp, rec] = await Promise.all([computeInputs(db, st, p), db.staffSalaryRecord.findUnique({ where: { staffKey_periodStart: { staffKey: st.key, periodStart: dateOnly(p.start) } } })]);
  return { staff: st, period: p, auto: { ...inp, orderSalary: inp.orderCount * inp.cfg.oppRatePerOrder, penaltyTotal: inp.penalties.reduce((s, x) => s + x.remaining, 0) }, record: rec, dayLabels: DAY_TYPE_LABEL };
}

export interface SaveInput {
  staffKey?: unknown; ym?: unknown; half?: unknown; baseSalary?: unknown; bonusSalary?: unknown; additions?: unknown; deductions?: unknown;
  penaltyDeducted?: unknown; loanIds?: unknown; debtPayments?: unknown; notes?: unknown; bankName?: unknown; bankAccount?: unknown; version?: unknown;
}

/** Хадгалах — бүх нийлбэрийг сервер тооцно. Цоожтой бол 423 */
export async function saveSalary(actor: UserActor, input: SaveInput) {
  assert(actor);
  const st = await staffOf(db, String(input.staffKey ?? ''));
  const p = periodOf(String(input.ym ?? ''), Number(input.half));
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(8::int4, hashtext(${st.key + p.start}))`;
    const ex = await tx.staffSalaryRecord.findUnique({ where: { staffKey_periodStart: { staffKey: st.key, periodStart: dateOnly(p.start) } } });
    if (ex?.isLocked) throw new AppError(423, 'Цалин цоожтой байна. Эхлээд цоожийг тайлна уу.', 'locked');
    if (ex && input.version !== undefined && Number(input.version) !== ex.version) throw conflict('Өөр хүн дөнгөж сая өөрчилсөн — дахин ачаална уу', 'stale');
    const inp = await computeInputs(tx, st, p);
    const orderBased = !st.external && inp.cfg.salaryType === 'ORDER_BASED' && inp.isOpp;
    const baseSalary = orderBased ? 0 : input.baseSalary === undefined ? inp.calcBase : cleanInt(input.baseSalary, 'Үндсэн цалин');
    const bonusSalary = input.bonusSalary === undefined ? inp.cfg.bonusSalary : cleanInt(input.bonusSalary, 'Урамшуулал');
    const orderSalary = orderBased ? inp.orderCount * inp.cfg.oppRatePerOrder : 0;
    const additions = cleanLines(input.additions, 'Нэмэлт орлого').filter((x) => x.label !== EVAL_LABEL);
    if (inp.evalSalary > 0) additions.push({ label: EVAL_LABEL, amount: inp.evalSalary });
    const deductions = cleanLines(input.deductions, 'Суутгал');
    const penaltyTotal = inp.penalties.reduce((s, x) => s + x.remaining, 0);
    const penaltyDeducted = input.penaltyDeducted === undefined ? penaltyTotal : cleanInt(input.penaltyDeducted, 'Хасах торгууль');
    if (penaltyDeducted > penaltyTotal) throw badRequest(`Хасах торгууль ${money(penaltyTotal)}-с их байж болохгүй`, 'penalty_over');
    // Цоож тайлсан ч аль хэдийн суутгасан зээл түгжигдсэн хэвээр (#124-6): мөр нь хасагдахгүй, дүн өөрчлөгдөхгүй
    const charged = new Set(((ex?.applied as Applied | null)?.loansCharged ?? []));
    const fixedLoans = ((ex?.loans as { loanId: number; label: string; amount: number }[] | null) ?? []).filter((l) => charged.has(l.loanId));
    const loanIds = (Array.isArray(input.loanIds) ? input.loanIds : []).map(Number).filter((lid) => !charged.has(lid));
    const newLoans = inp.loans.filter((l) => loanIds.includes(l.id)).map((l) => ({ loanId: l.id, label: `Зээлсэн бараа #${l.id} (${l.pieces}ш)`, amount: l.amount }));
    if (newLoans.length !== new Set(loanIds).size) throw conflict('Зээлийн мэдээлэл өөрчлөгдсөн — дахин ачаална уу', 'stale');
    const loans = [...fixedLoans, ...newLoans];
    const debtPayments = (Array.isArray(input.debtPayments) ? input.debtPayments : []).map((x) => {
      const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
      const d = inp.debts.find((y) => y.id === Number(o.debtId));
      if (!d) throw conflict('Өр олдсонгүй — дахин ачаална уу', 'stale');
      const amount = cleanInt(o.amount, 'Өрийн төлөлт');
      if (amount > d.remainingAmount) throw badRequest(`«${d.description}» үлдэгдэл ${money(d.remainingAmount)}`, 'debt_over');
      return { debtId: d.id, label: `Өр: ${d.description}`, amount };
    }).filter((x) => x.amount > 0);
    const totalAdditions = additions.reduce((s, x) => s + x.amount, 0);
    const totalDeductions = deductions.reduce((s, x) => s + x.amount, 0);
    const loanTotal = loans.reduce((s, x) => s + x.amount, 0);
    const debtTotal = debtPayments.reduce((s, x) => s + x.amount, 0);
    const grossSalary = (orderBased ? orderSalary : baseSalary) + bonusSalary + totalAdditions;
    const transferSalary = grossSalary - totalDeductions - penaltyDeducted - debtTotal - loanTotal;
    const data = {
      staffName: st.name, staffRole: st.roleLabel, userId: st.userId, externalId: st.externalId, periodEnd: dateOnly(p.end), periodLabel: p.label,
      salaryType: orderBased ? 'ORDER_BASED' : 'FIXED', workingDays: inp.workingDays, totalDays: inp.totalDays, dailyRate: inp.dailyRate,
      baseSalary, bonusSalary, orderCount: orderBased ? inp.orderCount : 0, orderRate: orderBased ? inp.cfg.oppRatePerOrder : 0, orderSalary,
      additions: additions as unknown as Prisma.InputJsonValue, totalAdditions, deductions: deductions as unknown as Prisma.InputJsonValue, totalDeductions,
      penaltyTotal, penaltyDeducted, loans: loans as unknown as Prisma.InputJsonValue, loanTotal, debtPayments: debtPayments as unknown as Prisma.InputJsonValue, debtTotal,
      grossSalary, transferSalary, notes: String(input.notes ?? '').trim().slice(0, 1000) || null,
      bankName: String(input.bankName ?? inp.cfg.bankName).trim().slice(0, 60), bankAccount: String(input.bankAccount ?? inp.cfg.bankAccount).trim().slice(0, 40),
    };
    const r = ex
      ? await tx.staffSalaryRecord.update({ where: { id: ex.id }, data: { ...data, updatedByName: actor.name, version: { increment: 1 } } })
      : await tx.staffSalaryRecord.create({ data: { ...data, staffKey: st.key, periodStart: dateOnly(p.start), createdByName: actor.name } });
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (ex) for (const k of ['baseSalary', 'bonusSalary', 'orderSalary', 'totalAdditions', 'totalDeductions', 'penaltyDeducted', 'loanTotal', 'debtTotal', 'transferSalary', 'bankAccount', 'notes'] as const) if (ex[k] !== r[k]) changes[k] = { from: ex[k], to: r[k] };
    await writeAudit(actor, ex ? 'salary.updated' : 'salary.created', 'StaffSalaryRecord', String(r.id), { staff: st.name, period: p.label, transferSalary, ...(ex ? { changes } : {}) } as Prisma.InputJsonValue, tx, ['salary', 'money']);
    return r;
  });
}

export async function setTransferred(actor: UserActor, idIn: unknown, value: unknown) {
  assert(actor);
  const id = Number(idIn);
  const r = await db.staffSalaryRecord.findUnique({ where: { id } });
  if (!r) throw notFound('Цалин олдсонгүй');
  const v = value === true;
  await db.staffSalaryRecord.update({ where: { id }, data: { transferred: v, transferredAt: v ? new Date() : null, transferredByName: v ? actor.name : null } });
  await writeAudit(actor, v ? 'salary.transferred' : 'salary.untransferred', 'StaffSalaryRecord', String(id), { staff: r.staffName, period: r.periodLabel, amount: r.transferSalary }, db, ['salary', 'money']);
  return { ok: true };
}

// ───────────────────────── Цоож — торгууль, зээл, өр ХЭРЭГЖИНЭ ─────────────────────────

interface Applied { penalties: { id: number; amount: number }[]; loansCharged: number[]; debtPaymentIds: number[] }

export async function lockSalary(actor: UserActor, idIn: unknown) {
  assert(actor);
  const id = Number(idIn);
  const pre = Number.isInteger(id) && id > 0 ? await db.staffSalaryRecord.findUnique({ where: { id }, select: { staffKey: true, periodStart: true } }) : null;
  if (!pre) throw notFound('Цалин олдсонгүй');
  return db.$transaction(async (tx) => {
    // Аудит А4: хадгалахтай ижил түгжээ (хадгалах ба түгжих зэрэг ирэхэд нэг нь нөгөөгөө хүлээнэ), дараа нь мөрийн түгжээ
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(8::int4, hashtext(${pre.staffKey + ymdOf(pre.periodStart)}))`;
    // Нэг ажилтны торгууль хоёр хагас сард давхар суутгагдахгүй — ажилтан тус бүрийн түгжээ
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(9::int4, hashtext(${pre.staffKey}))`;
    const rows = await tx.$queryRaw<{ id: number }[]>`SELECT id FROM "StaffSalaryRecord" WHERE id = ${id} FOR UPDATE`;
    if (!rows.length) throw notFound('Цалин олдсонгүй');
    const r = await tx.staffSalaryRecord.findUniqueOrThrow({ where: { id } });
    if (r.isLocked) return { record: r, duplicate: true };
    const st = await staffOf(tx, r.staffKey);
    const p = periodOf(ymdOf(r.periodStart).slice(0, 7), Number(ymdOf(r.periodStart).slice(8)) === 1 ? 1 : 2);
    const inp = await computeInputs(tx, st, p);
    const prev = (r.applied as Applied | null) ?? { penalties: [], loansCharged: [], debtPaymentIds: [] };
    // Аудит А7: хадгалсны дараа маркетингийн үнэлгээ өөрчлөгдсөн бол хуучин дүнгээр түгжихгүй
    const savedEval = ((r.additions as { label: string; amount: number }[] | null) ?? []).filter((x) => x.label === EVAL_LABEL).reduce((s2, x) => s2 + x.amount, 0);
    if (savedEval !== inp.evalSalary) throw conflict(`Маркетингийн үнэлгээний цалин өөрчлөгдсөн (${money(savedEval)} → ${money(inp.evalSalary)}) — цалинг дахин хадгална уу`, 'stale');
    // Торгууль: хуучнаас нь эхлэн хассан дүнгээр (бүрэн → «Цалингаас хассан», хэсэгчилсэн → үлдэгдэлтэй)
    const pt = inp.penalties.reduce((s, x) => s + x.remaining, 0);
    if (r.penaltyDeducted > pt) throw conflict(`Торгуулийн үлдэгдэл өөрчлөгдсөн (${money(pt)}) — цалинг дахин хадгална уу`, 'stale');
    let left = r.penaltyDeducted;
    const penApplied: { id: number; amount: number }[] = [];
    for (const x of inp.penalties) {
      if (left <= 0) break;
      const a = Math.min(left, x.remaining);
      const full = a === x.remaining;
      // Үлдэгдлээс хэтрүүлэхгүй (давхар суутгалаас) — нөхцөлтэй
      const g = await tx.$executeRaw`UPDATE "Penalty" SET "deductedAmount" = "deductedAmount" + ${a}, version = version + 1 WHERE id = ${x.id} AND status = 'ACTIVE' AND deducted = false AND "deductedAmount" + ${a} <= amount`;
      if (!g) throw conflict('Торгуулийн үлдэгдэл өөрчлөгдсөн — цалинг дахин хадгална уу', 'stale');
      if (full) await tx.penalty.update({ where: { id: x.id }, data: { deducted: true, deductedAt: new Date(), deductedByName: `${actor.name} (цалин ${r.periodLabel})` } });
      penApplied.push({ id: x.id, amount: a });
      left -= a;
    }
    // Зээлсэн бараа: «Цалингаас суутгах» (Бараа зээлтэй ижил — барааны журналаар, давхардахгүй)
    const saved = ((r.loans as { loanId: number; amount: number }[]) ?? []).filter((l) => !prev.loansCharged.includes(l.loanId));
    const loanIds = saved.map((l) => l.loanId);
    // Аудит №6: хадгалснаас хойш буцаалт / суутгалын өөрчлөлт болсон бол хадгалсан дүнгээр суутгахгүй — дахин хадгалуулна
    for (const l of saved) {
      const now = inp.loans.find((x) => x.id === l.loanId);
      if (!now) throw conflict(`Зээл #${l.loanId} аль хэдийн хаагдсан — цалинг дахин хадгална уу`, 'stale');
      if (now.amount !== l.amount) throw conflict(`Зээл #${l.loanId}-ийн суутгах дүн өөрчлөгдсөн (${money(l.amount)} → ${money(now.amount)}) — цалинг дахин хадгална уу`, 'stale');
    }
    for (const l of saved) {
      const res = await chargeLoanTx(tx, actor, l.loanId, `Цалингаас суутгав — ${st.name} ${r.periodLabel}`);
      if (res.duplicate) throw conflict(`Зээл #${l.loanId} аль хэдийн хаагдсан — цалинг дахин хадгална уу`, 'stale');
      if (res.amount !== l.amount) throw conflict(`Зээл #${l.loanId}-ийн суутгах дүн өөрчлөгдсөн (${money(l.amount)} → ${money(res.amount)}) — цалинг дахин хадгална уу`, 'stale');
    }
    // Өрийн төлөлт
    const payIds: number[] = [];
    for (const d of (r.debtPayments as { debtId: number; amount: number }[]) ?? []) {
      const n = await tx.staffDebt.updateMany({ where: { id: d.debtId, isActive: true, remainingAmount: { gte: d.amount } }, data: { remainingAmount: { decrement: d.amount } } });
      if (!n.count) throw conflict('Өрийн үлдэгдэл өөрчлөгдсөн — цалинг дахин хадгална уу', 'stale');
      await tx.staffDebt.updateMany({ where: { id: d.debtId, remainingAmount: 0 }, data: { isActive: false } });
      const pmt = await tx.staffDebtPayment.create({ data: { debtId: d.debtId, recordId: id, periodLabel: r.periodLabel, amount: d.amount, note: 'Цалингаас суутгав', createdByName: actor.name } });
      payIds.push(pmt.id);
    }
    const applied: Applied = { penalties: penApplied, loansCharged: [...prev.loansCharged, ...loanIds], debtPaymentIds: payIds };
    const u = await tx.staffSalaryRecord.update({ where: { id }, data: { isLocked: true, lockedAt: new Date(), lockedByName: actor.name, applied: applied as unknown as Prisma.InputJsonValue, version: { increment: 1 } } });
    await writeAudit(actor, 'salary.locked', 'StaffSalaryRecord', String(id), { staff: r.staffName, period: r.periodLabel, transferSalary: r.transferSalary, penalties: penApplied.length, loans: loanIds.length, debts: payIds.length }, tx, ['salary', 'money']);
    return { record: u, duplicate: false };
  });
}

/** Цоож тайлах — кодоор (Супер админ тохируулсан). Торгууль, өрийн төлөлт буцна; зээл (барааны хөдөлгөөн) хэвээр */
export async function unlockSalary(actor: UserActor, idIn: unknown, input: { code?: unknown }) {
  assert(actor);
  const id = Number(idIn);
  const s = await db.appSetting.findUnique({ where: { key: KEY_CODE } });
  const code = String(input.code ?? '');
  if (s) { if (!(await verifyPassword(code, String(s.value)))) throw forbidden('Буруу код'); }
  else if (!isSA(actor)) throw forbidden('Цоожны код тохируулаагүй — Супер админ тайлна (эсвэл кодоо тохируулна)');
  const pre = Number.isInteger(id) && id > 0 ? await db.staffSalaryRecord.findUnique({ where: { id }, select: { staffKey: true, periodStart: true } }) : null;
  if (!pre) throw notFound('Цалин олдсонгүй');
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(8::int4, hashtext(${pre.staffKey + ymdOf(pre.periodStart)}))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(9::int4, hashtext(${pre.staffKey}))`;
    const rows = await tx.$queryRaw<{ id: number }[]>`SELECT id FROM "StaffSalaryRecord" WHERE id = ${id} FOR UPDATE`;
    if (!rows.length) throw notFound('Цалин олдсонгүй');
    const r = await tx.staffSalaryRecord.findUniqueOrThrow({ where: { id } });
    if (!r.isLocked) return { record: r, duplicate: true };
    const a = (r.applied as Applied | null) ?? { penalties: [], loansCharged: [], debtPaymentIds: [] };
    // Зөвхөн энэ цалингаар хассан дүн буцна; гараар «Цалингаас хассан» гэсэн тэмдэг хэвээр (#124-Е2)
    for (const x of a.penalties) {
      const p = await tx.penalty.update({ where: { id: x.id }, data: { deductedAmount: { decrement: x.amount }, version: { increment: 1 } } });
      // Аудит А4: цалингаар (аль ч хугацаа) эсвэл «үлдэгдэл цуцалсан»-аар хаагдсан тэмдэг — бүрэн хасагдаагүй болсон бол буцна.
      // Гараар «Цалингаас хассан» гэсэн тэмдэг хэвээр (#124-Е2).
      const sys = !!p.deductedByName && (/\(цалин .+\)$/.test(p.deductedByName) || p.deductedByName.includes('(үлдэгдэл цуцалсан)'));
      if (p.deducted && sys && p.deductedAmount < p.amount) await tx.penalty.update({ where: { id: x.id }, data: { deducted: false, deductedAt: null, deductedByName: null } });
    }
    for (const pid of a.debtPaymentIds) {
      const pm = await tx.staffDebtPayment.findUnique({ where: { id: pid } });
      if (!pm) continue;
      await tx.staffDebt.update({ where: { id: pm.debtId }, data: { remainingAmount: { increment: pm.amount }, isActive: true } });
      await tx.staffDebtPayment.delete({ where: { id: pid } });
    }
    const u = await tx.staffSalaryRecord.update({ where: { id }, data: { isLocked: false, lockedAt: null, lockedByName: null, applied: { penalties: [], loansCharged: a.loansCharged, debtPaymentIds: [] } as unknown as Prisma.InputJsonValue, version: { increment: 1 } } });
    await writeAudit(actor, 'salary.unlocked', 'StaffSalaryRecord', String(id), { staff: r.staffName, period: r.periodLabel, penaltiesReverted: a.penalties.length, debtsReverted: a.debtPaymentIds.length, loansKept: a.loansCharged.length }, tx, ['salary', 'money']);
    return { record: u, duplicate: false };
  });
}

export async function setLockCode(actor: UserActor, input: { code?: unknown }) {
  if (!isSA(actor)) throw forbidden('Цоожны кодыг Супер админ тохируулна');
  const code = String(input.code ?? '').trim();
  if (!/^\S{4,32}$/.test(code)) throw badRequest('Код 4–32 тэмдэгт (зайгүй)');
  const h = await hashPassword(code);
  await db.appSetting.upsert({ where: { key: KEY_CODE }, create: { key: KEY_CODE, value: h, updatedById: actor.id }, update: { value: h, updatedById: actor.id } });
  await writeAudit(actor, 'salary.lock_code', 'AppSetting', KEY_CODE, { changed: true }, db, ['salary', 'settings', 'security']);
  return { ok: true };
}

// ───────────────────────── Ажилтны өр ─────────────────────────

export async function listDebts(actor: UserActor, staffKeyIn?: unknown) {
  assert(actor);
  const where: Prisma.StaffDebtWhereInput = staffKeyIn ? { staffKey: String(staffKeyIn) } : { isActive: true };
  const items = await db.staffDebt.findMany({ where, include: { payments: { orderBy: { createdAt: 'desc' } } }, orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }], take: 300 });
  return { items, total: items.filter((d) => d.isActive).reduce((s, d) => s + d.remainingAmount, 0) };
}
export async function addDebt(actor: UserActor, input: { staffKey?: unknown; description?: unknown; amount?: unknown }) {
  assert(actor);
  const st = await staffOf(db, String(input.staffKey ?? ''));
  const description = String(input.description ?? '').trim().slice(0, 200);
  if (description.length < 2) throw badRequest('Өрийн тайлбараа бичнэ үү');
  const amount = cleanInt(input.amount, 'Дүн');
  if (amount <= 0) throw badRequest('Дүн буруу');
  const d = await db.staffDebt.create({ data: { staffKey: st.key, staffName: st.name, description, totalAmount: amount, remainingAmount: amount, createdByName: actor.name } });
  await writeAudit(actor, 'salary.debt_added', 'StaffDebt', String(d.id), { staff: st.name, description, amount }, db, ['salary', 'money']);
  return d;
}

/** Засварын түүх (хуучин «Түүх» цонх) */
export async function recordHistory(actor: UserActor, idIn: unknown) {
  assert(actor);
  const id = String(Number(idIn));
  const rows = await db.auditLog.findMany({ where: { entityType: 'StaffSalaryRecord', entityId: id }, orderBy: { at: 'desc' }, take: 100, select: { action: true, actorName: true, at: true, details: true } });
  return { items: rows };
}
