import { Prisma, type DeliveryPayment, type IssueFault } from '@prisma/client';
import { db } from '../../db';
import { dateOnly, ubDayStart, ymdOf } from '../../ubdate';
import { addDays } from '../delivery/core';

type Tx = Prisma.TransactionClient;

/**
 * Модуль 6 — жолоочийн өдрийн тооцоо (НЭГ функц: нягтлан, жолоочийн «Орлого», тайлан бүгд үүнийг ашиглана).
 *
 * Тооцооны өдөр = ПАДААНЫ өдөр (#83): тухайн өдрийн падаанд туссан захиалга бүр тэр өдрийн тооцоонд үлдэнэ —
 *   хүргэсэн / цуцалсан / маргааш / хүргэлтэд (дуусаагүй). Шөнө дундаас хойш хүргэсэн, нягтлан хожим төлөв сольсон ч өөр өдөр рүү шилжихгүй.
 *   «Маргааш» болсон захиалга тэр өдөрт «маргааш» гэж (гүйцэтгэлд цуцалсантай адил, хуучин шиг), дараагийн өдрийн шинэ падаанд хүргэсэн гэж.
 * Гүйцэтгэл % = хүргэсэн ÷ (хүргэсэн + цуцалсан + маргааш) — асуудлаар (опп / маркетинг / агуулахын алдаа) цуцлагдсан нь хасагдана (хуучин шиг).
 * Хүлээн авах дүн = хүргэсэн дүн (төлөөгүй ч орно — жолооч тушаана, #82 1) − урьдчилж төлсөн (орон нутаг) − цалин.
 */

export interface Tiers { high: number; mid: number }
export interface SalaryRules {
  /** Нэг захиалгын хөлс: өндөр / дунд / бага */
  rates: { high: number; mid: number; low: number };
  /** Орон нутгийн горимын анхны хөлс */
  regionalDefault: number;
  /** «Олон захиалга» босго (хуучин 35) */
  bigCount: number;
  /** 35+ эсвэл гараар засагдсан: ≥high% → өндөр, ≥mid% → дунд */
  big: Tiers;
  /** 35-аас цөөн */
  small: Tiers;
  /** Тусгай гүйцэтгэлтэй жолооч */
  special: Tiers;
  /** Цалин бодох арга (#139): PERF — гүйцэтгэлээр (дээрх босго), FLAT — 1 хүргэлт тогтмол (цуцлалт хамаагүй). Орон нутаг өөрийн дүнгээр */
  basis: 'PERF' | 'FLAT';
  /** FLAT үеийн 1 хүргэлтийн хөлс (анх 5,000₮, Супер админ засна) */
  flatRate: number;
}
export const DEFAULT_RULES: SalaryRules = {
  rates: { high: 5000, mid: 4500, low: 4000 },
  regionalDefault: 3000,
  bigCount: 35,
  big: { high: 94.5, mid: 89.5 },
  small: { high: 100, mid: 90 },
  special: { high: 91.5, mid: 86.4 },
  basis: 'PERF',
  flatRate: 5000,
};

export type PayMode = 'NORMAL' | 'SPECIAL' | 'REGIONAL';
export const MODE_LABEL: Record<PayMode, string> = { NORMAL: 'Энгийн', SPECIAL: 'Тусгай', REGIONAL: 'Орон нутаг' };
export type Tier = 'regional' | 'flat' | 'special' | 'manual' | 'big' | 'small';

/** Хуучин ERP-ийн цалингийн хүснэгт (яг ижил дараалал): орон нутаг → тусгай → гараар засагдсан → 35+ → 35-аас цөөн */
export function rateFor(rules: SalaryRules, mode: { mode: PayMode; regionalRate: number | null }, perf: number, countable: number, manual: boolean): { rate: number; tier: Tier } {
  const pick = (t: Tiers) => (perf >= t.high ? rules.rates.high : perf >= t.mid ? rules.rates.mid : rules.rates.low);
  if (mode.mode === 'REGIONAL') return { rate: mode.regionalRate ?? rules.regionalDefault, tier: 'regional' };
  if (rules.basis === 'FLAT') return { rate: rules.flatRate, tier: 'flat' };
  if (mode.mode === 'SPECIAL') return { rate: pick(rules.special), tier: 'special' };
  if (manual) return { rate: pick(rules.big), tier: 'manual' };
  if (countable >= rules.bigCount) return { rate: pick(rules.big), tier: 'big' };
  return { rate: pick(rules.small), tier: 'small' };
}

/** Тухайн өдөр хүчинтэй цалингийн дүрэм (хамгийн сүүлийн «хүчинтэй өдөр» ≤ өдөр) */
export async function rulesFor(tx: Tx | typeof db, ymd: string): Promise<SalaryRules & { effectiveFrom: string | null }> {
  const r = await tx.salaryRule.findFirst({ where: { effectiveFrom: { lte: dateOnly(ymd) } }, orderBy: { effectiveFrom: 'desc' } });
  if (!r) return { ...DEFAULT_RULES, effectiveFrom: null };
  return { ...DEFAULT_RULES, ...(r.rules as object), effectiveFrom: ymdOf(r.effectiveFrom) } as SalaryRules & { effectiveFrom: string | null };
}

/** Жолоочдын тухайн өдөр хүчинтэй горим */
export async function modesFor(tx: Tx | typeof db, driverIds: string[], ymd: string): Promise<Map<string, { mode: PayMode; regionalRate: number | null }>> {
  const m = new Map<string, { mode: PayMode; regionalRate: number | null }>();
  if (!driverIds.length) return m;
  const rows = await tx.$queryRaw<{ driverId: string; mode: string; regionalRate: number | null }[]>`
    SELECT DISTINCT ON ("driverId") "driverId", mode, "regionalRate" FROM "DriverPayMode"
    WHERE "driverId" = ANY(${driverIds}::uuid[]) AND "effectiveFrom" <= ${dateOnly(ymd)}::date
    ORDER BY "driverId", "effectiveFrom" DESC`;
  for (const r of rows) m.set(r.driverId, { mode: r.mode as PayMode, regionalRate: r.regionalRate });
  return m;
}

export type Outcome = 'DELIVERED' | 'CANCELLED' | 'EXCLUDED' | 'POSTPONED' | 'OUT' | 'NOT_RECEIVED';
export const OUTCOME_LABEL: Record<Outcome, string> = {
  DELIVERED: 'Хүргэсэн', CANCELLED: 'Цуцласан', EXCLUDED: 'Цуцласан (гүйцэтгэлд тооцохгүй)', POSTPONED: 'Маргааш', OUT: 'Хүргэлтэд', NOT_RECEIVED: 'Падаан хүлээн аваагүй',
};
/** Асуудлаар цуцлагдсан, жолоочийн алдаа биш → гүйцэтгэлээс хасна (хуучин excludedFromPerformance) */
export const isExcluded = (cancelReason: string | null, fault: IssueFault | null) => (cancelReason === 'ISSUE' && fault !== 'DRIVER')
  // Хүргэлтэд гарсныг оператор цуцалсан (#124 ялгаа 1) — жолоочийн гүйцэтгэлд тоологдохгүй
  || (fault === 'OPERATOR' && cancelReason !== 'DRIVER_CANCELLED');

export interface DayRow {
  handoverId: number; orderId: number; number: string; status: string; total: number; originalTotal: number | null; prepaid: boolean;
  deliveryPayment: DeliveryPayment | null; cancelReason: string | null; issueFault: IssueFault | null; postponed: boolean; driverId: string; outcome: Outcome;
}

/** Падааны мөрүүд (идэвхтэй + «Маргааш») — индексээр: Handover(date) → HandoverOrder(handoverId) → Order(pk) */
export async function dayRows(tx: Tx | typeof db, ymd: string, driverId?: string): Promise<DayRow[]> {
  const d = dateOnly(ymd);
  const rows = await tx.$queryRaw<Omit<DayRow, 'outcome'>[]>`
    SELECT h.id AS "handoverId", h."driverId", o.id AS "orderId", o.number, o.status::text AS status, o.total, o."originalTotal", o.prepaid,
           o."deliveryPayment", o."cancelReason"::text AS "cancelReason", o."issueFault", (ho."removedAt" IS NOT NULL) AS postponed
    FROM "Handover" h
    JOIN "HandoverOrder" ho ON ho."handoverId" = h.id
    JOIN "Order" o ON o.id = ho."orderId"
    WHERE h.date = ${d}::date ${driverId ? Prisma.sql`AND h."driverId" = ${driverId}::uuid` : Prisma.empty}
      AND (ho."removedAt" IS NULL AND o."handoverId" = h.id OR ho."removeReason" = 'Маргааш (бараа жолоочид)')
    ORDER BY h.id, ho.position`;
  return rows.map((r) => ({ ...r, outcome: outcomeOf(r) }));
}

function outcomeOf(r: Omit<DayRow, 'outcome'>): Outcome {
  if (r.postponed) return 'POSTPONED';
  if (r.status === 'DELIVERED') return 'DELIVERED';
  if (r.status === 'CANCELLED') return isExcluded(r.cancelReason, r.issueFault) ? 'EXCLUDED' : 'CANCELLED';
  if (r.status === 'OUT_FOR_DELIVERY') return 'OUT';
  return 'NOT_RECEIVED';
}

export interface DriverDay {
  driverId: string; driverName: string; date: string;
  handover: { id: number; number: string; status: string } | null;
  total: number; delivered: number; cancelled: number; excluded: number; postponed: number; out: number; notReceived: number;
  countable: number; deliveredAmount: number; prepaidAmount: number; prepaidCount: number; cancelledAmount: number;
  cash: number; bank: number; unpaid: number; partialCount: number; refusedAmount: number;
  perfCalc: number; perfOverride: number | null; perf: number; mode: PayMode; regionalRate: number | null; rate: number; tier: Tier;
  salary: number; toReceive: number;
  extraSale: { count: number; amount: number };
  settlement: SettlementView | null;
  locked: boolean;
}
export interface SettlementView {
  id: number; status: 'DRAFT' | 'PENDING' | 'COMPLETED'; cashAmount: number; bankAmount: number; debtAmount: number; expectedAmount: number;
  submittedAt: Date | null; approvedAt: Date | null; approvedByName: string | null;
  perfOverride: number | null; perfNote: string | null; perfByName: string | null; perfAt: Date | null;
  accountingSettled: boolean; settledAt: Date | null; settledByName: string | null; version: number;
}
const r2 = (n: number) => Math.round(n * 100) / 100;

function sv(s: Prisma.DriverSettlementGetPayload<object>): SettlementView {
  return {
    id: s.id, status: s.status, cashAmount: s.cashAmount, bankAmount: s.bankAmount, debtAmount: s.debtAmount, expectedAmount: s.expectedAmount,
    submittedAt: s.submittedAt, approvedAt: s.approvedAt, approvedByName: s.approvedByName,
    perfOverride: s.perfOverride === null ? null : Number(s.perfOverride), perfNote: s.perfNote, perfByName: s.perfByName, perfAt: s.perfAt,
    accountingSettled: s.accountingSettled, settledAt: s.settledAt, settledByName: s.settledByName, version: s.version,
  };
}

/**
 * Өдрийн бүх жолоочийн (эсвэл нэг жолоочийн) тооцоо. Баталгаажсан (COMPLETED) өдөр — баталгаажуулах үеийн хуулбараар (түгжигдсэн).
 */
export async function computeDay(tx: Tx | typeof db, ymd: string, driverId?: string, rulesOverride?: SalaryRules): Promise<DriverDay[]> {
  const d = dateOnly(ymd);
  const [rows, handovers, settlements, rules, sales] = await Promise.all([
    dayRows(tx, ymd, driverId),
    tx.handover.findMany({ where: { date: d, ...(driverId ? { driverId } : {}) }, select: { id: true, number: true, status: true, driverId: true, driverName: true } }),
    tx.driverSettlement.findMany({ where: { date: d, ...(driverId ? { driverId } : {}) } }),
    rulesOverride ? Promise.resolve(rulesOverride) : rulesFor(tx, ymd),
    tx.$queryRaw<{ driverId: string; n: number; amount: number }[]>`
      SELECT "driverId", count(*)::int AS n, coalesce(sum(total), 0)::int AS amount FROM "DriverDoc"
      WHERE kind = 'EXTRA_SALE' AND status = 'DONE' AND "createdAt" >= ${ubDayStart(ymd)} AND "createdAt" < ${ubDayStart(addDays(ymd, 1))}
      ${driverId ? Prisma.sql`AND "driverId" = ${driverId}::uuid` : Prisma.empty} GROUP BY 1`,
  ]);
  const ids = new Set<string>([...handovers.map((h) => h.driverId), ...settlements.map((s) => s.driverId)]);
  if (driverId) ids.add(driverId);
  const idList = [...ids];
  const [modes, users] = await Promise.all([
    modesFor(tx, idList, ymd),
    tx.user.findMany({ where: { id: { in: idList } }, select: { id: true, name: true } }),
  ]);
  const names = new Map(users.map((u) => [u.id, u.name]));
  const hm = new Map(handovers.map((h) => [h.driverId, h]));
  const smap = new Map(settlements.map((s) => [s.driverId, s]));
  const salesM = new Map(sales.map((s) => [s.driverId, s]));
  const byDriver = new Map<string, DayRow[]>();
  for (const r of rows) { const a = byDriver.get(r.driverId) ?? []; a.push(r); byDriver.set(r.driverId, a); }

  const out: DriverDay[] = [];
  for (const id of idList) {
    const s = smap.get(id);
    const h = hm.get(id);
    // Түгжигдсэн өдөр: баталгаажуулах үеийн тооцоог буцаана (дараа өөрчлөгдөхгүй)
    if (s?.status === 'COMPLETED' && s.snapshot) {
      out.push({ ...(s.snapshot as unknown as DriverDay), settlement: sv(s), locked: true });
      continue;
    }
    const list = byDriver.get(id) ?? [];
    const c = { delivered: 0, cancelled: 0, excluded: 0, postponed: 0, out: 0, notReceived: 0 };
    let deliveredAmount = 0, prepaidAmount = 0, prepaidCount = 0, cancelledAmount = 0, cash = 0, bank = 0, unpaid = 0, partialCount = 0, refusedAmount = 0;
    for (const r of list) {
      switch (r.outcome) {
        case 'DELIVERED':
          c.delivered++; deliveredAmount += r.total;
          if (r.prepaid) { prepaidAmount += r.total; prepaidCount++; }
          else if (r.deliveryPayment === 'CASH') cash += r.total;
          else if (r.deliveryPayment === 'BANK') bank += r.total;
          else if (r.deliveryPayment === 'UNPAID') unpaid += r.total;
          if (r.originalTotal !== null && r.originalTotal > r.total) { partialCount++; refusedAmount += r.originalTotal - r.total; }
          break;
        case 'CANCELLED': c.cancelled++; cancelledAmount += r.total; break;
        case 'EXCLUDED': c.excluded++; cancelledAmount += r.total; break;
        case 'POSTPONED': c.postponed++; break;
        case 'OUT': c.out++; break;
        default: c.notReceived++;
      }
    }
    const countable = c.delivered + c.cancelled + c.postponed;
    const perfCalc = countable > 0 ? (c.delivered / countable) * 100 : 0;
    const perfOverride = s?.perfOverride === null || s?.perfOverride === undefined ? null : Number(s.perfOverride);
    const perf = perfOverride ?? perfCalc;
    const mode = modes.get(id) ?? { mode: 'NORMAL' as PayMode, regionalRate: null };
    const { rate, tier } = rateFor(rules, mode, perf, countable, perfOverride !== null);
    const salary = c.delivered * rate;
    out.push({
      driverId: id, driverName: names.get(id) ?? h?.driverName ?? s?.driverName ?? '—', date: ymd,
      handover: h ? { id: h.id, number: h.number, status: h.status } : null,
      total: list.length, ...c, countable,
      deliveredAmount, prepaidAmount, prepaidCount, cancelledAmount, cash, bank, unpaid, partialCount, refusedAmount,
      perfCalc: r2(perfCalc), perfOverride, perf: r2(perf), mode: mode.mode, regionalRate: mode.regionalRate, rate, tier,
      salary, toReceive: deliveredAmount - prepaidAmount - salary,
      extraSale: { count: salesM.get(id)?.n ?? 0, amount: salesM.get(id)?.amount ?? 0 },
      settlement: s ? sv(s) : null, locked: false,
    });
  }
  return out.sort((a, b) => a.driverName.localeCompare(b.driverName, 'mn'));
}

export async function computeDriverDay(tx: Tx | typeof db, ymd: string, driverId: string): Promise<DriverDay> {
  return (await computeDay(tx, ymd, driverId))[0]!;
}

/** Гүйцэтгэлийн дүрмийн тайлбар (жолооч, нягтланд харуулах — хуучин «Цалингийн хувь тооцоолох дүрэм») */
export function rulesText(rules: SalaryRules) {
  const m = (n: number) => `${n.toLocaleString('en-US')}₮`;
  if (rules.basis === 'FLAT') {
    return [
      { key: 'flat', title: '1 хүргэлт тогтмол (гүйцэтгэлгүй)', lines: [`${m(rules.flatRate)} / хүргэлт — цуцалсан, маргааш хамаагүй`] },
      { key: 'regional', title: 'Орон нутаг', lines: [`Өөрийн тохируулсан хөлс (анх ${m(rules.regionalDefault)})`] },
    ];
  }
  const t = (x: Tiers) => [`≥${x.high}% → ${m(rules.rates.high)}`, `≥${x.mid}% → ${m(rules.rates.mid)}`, `бусад → ${m(rules.rates.low)}`];
  return [
    { key: 'big', title: `${rules.bigCount}+ захиалга (эсвэл гараар засагдсан)`, lines: t(rules.big) },
    { key: 'small', title: `${rules.bigCount}-аас цөөн захиалга`, lines: t(rules.small) },
    { key: 'special', title: 'Тусгай гүйцэтгэл', lines: t(rules.special) },
    { key: 'regional', title: 'Орон нутаг', lines: [`Тогтмол хөлс (анх ${m(rules.regionalDefault)})`] },
  ];
}
