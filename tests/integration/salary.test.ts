import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Role } from '@prisma/client';
import { AppError } from '@/lib/errors';
import type { UserActor } from '@/lib/services/users';
import { resetDb } from '../helpers/reset';

/** Модуль 7б — Ажилтны цалин (#93): хуучин логик + цоожлоход торгууль/зээл/өр хэрэгжинэ, тайлахад буцна */
let db: typeof import('@/lib/db').db;
let S: typeof import('@/lib/services/salary');
let PN: typeof import('@/lib/services/penalties');
let P: typeof import('@/lib/services/products');
let W: typeof import('@/lib/services/stock/warehouses');
let D: typeof import('@/lib/services/stock/docs');
let LN: typeof import('@/lib/services/stock/loans');
let V: typeof import('@/lib/services/stock/views');
let O: typeof import('@/lib/services/orders/orders');
let A: typeof import('@/lib/services/orders/admin');
let U: typeof import('@/lib/ubdate');

beforeAll(async () => {
  process.env.DISABLE_JOBS = '1';
  db = (await import('@/lib/db')).db;
  S = await import('@/lib/services/salary');
  PN = await import('@/lib/services/penalties');
  P = await import('@/lib/services/products');
  W = await import('@/lib/services/stock/warehouses');
  D = await import('@/lib/services/stock/docs');
  LN = await import('@/lib/services/stock/loans');
  V = await import('@/lib/services/stock/views');
  O = await import('@/lib/services/orders/orders');
  A = await import('@/lib/services/orders/admin');
  U = await import('@/lib/ubdate');
});
let seq = 0;
async function actor(roles: Role[]): Promise<UserActor> {
  seq++;
  const u = await db.user.create({ data: { phone: String(79000000 + seq), name: `${roles.join('+')} ${seq}`, roles, passwordHash: 'x' } });
  return { id: u.id, name: u.name, roles: u.roles, ip: '127.0.0.1' };
}
async function err(p: Promise<unknown>, status: number, code?: string) {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(AppError); expect((e as AppError).status).toBe(status); if (code) expect((e as AppError).code).toBe(code); return; }
  throw new Error(`Алдаа гарах ёстой байсан (${status})`);
}
let sa: UserActor; let adm: UserActor; let acc: UserActor; let op: UserActor; let wh: UserActor; let pen: UserActor; let drv: UserActor;
let ym: string;
beforeEach(async () => {
  await resetDb(db as never);
  sa = await actor(['SUPER_ADMIN']); adm = await actor(['ADMIN']); acc = await actor(['ACCOUNTING']); op = await actor(['OPERATOR']); wh = await actor(['WAREHOUSE']); pen = await actor(['PENALTY_OFFICER']); drv = await actor(['DRIVER']);
  ym = U.ubDay().slice(0, 7);
});

describe('хагас сар, тогтмол цалин', () => {
  it('хугацаа 1–15 / 16–сүүл; 1 өдрийн цалин × ажилласан өдөр (Ч/Ө/Т/АМ хасна); шилжүүлэх = томъёо; эрх; самбар', async () => {
    expect(S.periodOf('2026-02', 2)).toMatchObject({ start: '2026-02-16', end: '2026-02-28', daysInMonth: 28 });
    await err(S.salaryBoard(op), 403);
    const key = `u:${wh.id}`;
    await S.setConfig(acc, { staffKey: key, salaryType: 'FIXED', baseSalary: 1_500_000, bonusSalary: 100_000, bankName: 'Хаан банк', bankAccount: '5000123456' });
    const p = S.periodOf(ym, 1);
    await S.setWorkDay(acc, { staffKey: key, date: p.start, dayType: 'SICK' });
    await S.setWorkDay(acc, { staffKey: key, date: `${ym}-02`, dayType: 'ABSENT' });
    const prep = await S.prepareSalary(acc, key, ym, 1);
    const daily = Math.round(1_500_000 / p.daysInMonth);
    expect([prep.auto.totalDays, prep.auto.workingDays, prep.auto.dailyRate, prep.auto.calcBase]).toEqual([15, 13, daily, Math.round((1_500_000 / p.daysInMonth) * 13)]);
    const r = await S.saveSalary(acc, { staffKey: key, ym, half: 1, additions: [{ label: 'Илүү цаг', amount: 50_000 }], deductions: [{ label: 'Хоцролт', amount: 20_000 }] });
    expect(r.transferSalary).toBe(prep.auto.calcBase + 100_000 + 50_000 - 20_000);
    expect(r.bankAccount).toBe('5000123456');
    // Гараар засах үндсэн цалин (хуучин шиг)
    const r2 = await S.saveSalary(acc, { staffKey: key, ym, half: 1, baseSalary: 700_000, bonusSalary: 0, version: r.version });
    expect(r2.transferSalary).toBe(700_000);
    await err(S.saveSalary(acc, { staffKey: key, ym, half: 1, version: r.version }), 409, 'stale');
    const b = await S.salaryBoard(acc, ym);
    expect(b.rows.find((x) => x.key === key)?.periods[0]?.transferSalary).toBe(700_000);
    expect(b.rows.some((x) => x.key === `u:${drv.id}`)).toBe(false); // жолооч «Тооцоо»-д
    await S.setTransferred(acc, r2.id, true);
    expect((await S.salaryBoard(acc, ym)).totals.transferred).toBe(700_000);
  });

  it('захиалгаар (оператор): тухайн хугацаанд авсан, хүргэгдсэн / мөнгө орсон захиалга × хөлс (хуучин шиг)', async () => {
    const key = `u:${op.id}`;
    await S.setConfig(acc, { staffKey: key, salaryType: 'ORDER_BASED', oppRatePerOrder: 1500, bonusSalary: 0 });
    const page = (await A.savePage(sa, { name: 'Шоп' })).id;
    const prod = await P.createProduct(sa, { code: 'S1', name: 'Бараа', price: 10000 });
    const whId = (await W.createWarehouse(sa, { name: 'Төв' })).id;
    await D.createReceipt(wh, { warehouseId: whId, lines: [{ variantId: prod.variants[0]!.id, qty: 10 }], idemKey: randomUUID() });
    const mk = async (o: Record<string, unknown> = {}) => (await O.createOrder(op, { phone: String(99400000 + ++seq), province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: 1, addressDetail: 'Тест 5-р байр', pageId: page, lines: [{ variantId: prod.variants[0]!.id, qty: 1 }], idemKey: randomUUID(), ...o })).order.id;
    const a1 = await mk(); const a2 = await mk(); const a3 = await mk({ prepaidWait: true });
    await db.order.update({ where: { id: a1 }, data: { status: 'DELIVERED' } });
    await O.markPaid(await actor(['OPERATOR_LEAD']), a3); // мөнгө орсон
    void a2; // Шинэ — тоологдохгүй
    const half = Number(U.ubDay().slice(8)) <= 15 ? 1 : 2;
    const prep = await S.prepareSalary(acc, key, ym, half);
    expect([prep.auto.orderCount, prep.auto.orderSalary]).toEqual([2, 3000]);
    const r = await S.saveSalary(acc, { staffKey: key, ym, half, baseSalary: 999_999 });
    expect([r.salaryType, r.orderSalary, r.baseSalary, r.transferSalary]).toEqual(['ORDER_BASED', 3000, 0, 3000]);
  });
});

describe('цоож: торгууль, зээл, өр — давхардахгүй, давхар харагдана', () => {
  it('торгуулийн нийлбэр + гараар дүн → цоожлоход хуучнаас нь эхлэн «хассан» (хэсэгчилсэн үлдэгдэлтэй); тайлахад буцна; код', async () => {
    const key = `u:${op.id}`;
    await S.setConfig(acc, { staffKey: key, baseSalary: 1_000_000 });
    const p1 = await PN.createPenalty(pen, { userId: op.id, customName: 'Коммент шүүгээгүй', amount: 5000 });
    const p2 = await PN.createPenalty(pen, { userId: op.id, customName: 'Чат шүүгээгүй', amount: 5000 });
    await PN.createPenalty(pen, { userId: op.id, customName: 'Хаяг тодорхойгүй', amount: 5000 }); // хуучин шиг хасагдахгүй
    const half = Number(U.ubDay().slice(8)) <= 15 ? 1 : 2;
    const prep = await S.prepareSalary(acc, key, ym, half);
    expect(prep.auto.penaltyTotal).toBe(10000);
    await err(S.saveSalary(acc, { staffKey: key, ym, half, penaltyDeducted: 20000 }), 400, 'penalty_over');
    const r = await S.saveSalary(acc, { staffKey: key, ym, half, baseSalary: 500_000, penaltyDeducted: 7000 });
    expect(r.transferSalary).toBe(493_000);
    await S.lockSalary(acc, r.id);
    await err(S.saveSalary(acc, { staffKey: key, ym, half }), 423, 'locked');
    let a = await db.penalty.findUniqueOrThrow({ where: { id: p1.id } }); let b = await db.penalty.findUniqueOrThrow({ where: { id: p2.id } });
    expect([a.deducted, a.deductedAmount, b.deducted, b.deductedAmount]).toEqual([true, 5000, false, 2000]);
    const mine = await PN.myPenalties(op, {});
    expect([mine.summary.deducted, mine.summary.pending]).toEqual([7000, 8000]);
    expect((await S.lockSalary(acc, r.id)).duplicate).toBe(true);
    // Код: тохируулаагүй бол зөвхөн Супер админ
    await err(S.unlockSalary(acc, r.id, {}), 403);
    await err(S.setLockCode(acc, { code: '1234' }), 403);
    await S.setLockCode(sa, { code: 'Nuuts55' });
    await err(S.unlockSalary(acc, r.id, { code: 'buruu' }), 403);
    await S.unlockSalary(acc, r.id, { code: 'Nuuts55' });
    a = await db.penalty.findUniqueOrThrow({ where: { id: p1.id } }); b = await db.penalty.findUniqueOrThrow({ where: { id: p2.id } });
    expect([a.deducted, a.deductedAmount, b.deductedAmount]).toEqual([false, 0, 0]);
    // Дахин цоожлоход давхардахгүй
    await S.lockSalary(acc, r.id); await S.unlockSalary(acc, r.id, { code: 'Nuuts55' }); await S.lockSalary(acc, r.id);
    expect((await db.penalty.aggregate({ _sum: { deductedAmount: true } }))._sum.deductedAmount).toBe(7000);
  });

  it('зээлсэн бараа «Бараа зээл»-тэй: хөнгөлөлттэй үнээр, цоожлоход «Цалингаас суутгасан» (барааны журналаар, тулгалт 0), дахин суутгагдахгүй; ажилтны өр хэсэгчлэн', async () => {
    const key = `u:${op.id}`;
    await S.setConfig(acc, { staffKey: key, baseSalary: 1_000_000 });
    const prod = await P.createProduct(sa, { code: 'L1', name: 'Бараа', price: 20000 });
    const v = prod.variants[0]!.id;
    const whId = (await W.createWarehouse(sa, { name: 'Төв' })).id;
    await D.createReceipt(wh, { warehouseId: whId, lines: [{ variantId: v, qty: 10 }], idemKey: randomUUID() });
    const loan = await LN.requestLoan(op, { lines: [{ variantId: v, qty: 2 }], idemKey: randomUUID() });
    await LN.issueLoan(wh, loan.loan.id, { warehouseId: whId });
    const debt = await S.addDebt(acc, { staffKey: key, description: 'Урьдчилгаа', amount: 100_000 });
    const half = Number(U.ubDay().slice(8)) <= 15 ? 1 : 2;
    const prep = await S.prepareSalary(acc, key, ym, half);
    expect(prep.auto.loans.map((l) => [l.pieces, l.amount])).toEqual([[2, 2 * (20000 - 5000)]]);
    await err(S.saveSalary(acc, { staffKey: key, ym, half, debtPayments: [{ debtId: debt.id, amount: 200_000 }] }), 400, 'debt_over');
    const r = await S.saveSalary(acc, { staffKey: key, ym, half, baseSalary: 500_000, loanIds: [loan.loan.id], debtPayments: [{ debtId: debt.id, amount: 40_000 }] });
    expect([r.loanTotal, r.debtTotal, r.transferSalary]).toEqual([30_000, 40_000, 430_000]);
    await S.lockSalary(adm, r.id);
    expect((await db.staffLoan.findUniqueOrThrow({ where: { id: loan.loan.id } })).status).toBe('CLOSED');
    expect((await db.staffDebt.findUniqueOrThrow({ where: { id: debt.id } })).remainingAmount).toBe(60_000);
    expect((await V.reconcile(sa, { fresh: true })).ok).toBe(true);
    await S.unlockSalary(sa, r.id, {});
    expect((await db.staffDebt.findUniqueOrThrow({ where: { id: debt.id } })).remainingAmount).toBe(100_000);
    expect((await db.staffLoan.findUniqueOrThrow({ where: { id: loan.loan.id } })).status).toBe('CLOSED'); // бараа хөдөлсөн — хэвээр
    // #124-6: цоож тайлсны дараа урамшуулал нэмж хадгална — суутгасан зээл (30,000₮) хэвээр, 409 гарахгүй
    const r2 = await S.saveSalary(acc, { staffKey: key, ym, half, baseSalary: 500_000, bonusSalary: 10_000, loanIds: [loan.loan.id], debtPayments: [{ debtId: debt.id, amount: 40_000 }] });
    expect([r2.loanTotal, r2.transferSalary]).toEqual([30_000, 440_000]);
    // зээлийн мөрийг хасах гэж оролдсон ч хэвээр
    const r3 = await S.saveSalary(acc, { staffKey: key, ym, half, baseSalary: 500_000, bonusSalary: 10_000, loanIds: [], debtPayments: [{ debtId: debt.id, amount: 40_000 }] });
    expect(r3.loanTotal).toBe(30_000);
    await S.lockSalary(adm, r.id); // зээлийг дахин суутгахгүй
    expect(await db.stockMove.count({ where: { type: 'LOAN_CHARGE' } })).toBe(1);
    expect((await db.staffDebt.findUniqueOrThrow({ where: { id: debt.id } })).remainingAmount).toBe(60_000);
    // Гадны ажилтан
    const x = await S.addExternal(acc, { name: 'Цэвэрлэгч Дулмаа', jobTitle: 'Цэвэрлэгч', baseSalary: 800_000 });
    const rx = await S.saveSalary(acc, { staffKey: `x:${x.id}`, ym, half: 1 });
    expect(rx.transferSalary).toBe(Math.round((800_000 / S.periodOf(ym, 1).daysInMonth) * 15));
    // Цоожтой хугацааны ажлын хуваарь засахгүй
    await S.lockSalary(acc, rx.id);
    await err(S.setWorkDay(acc, { staffKey: `x:${x.id}`, date: `${ym}-03`, dayType: 'SICK' }), 409, 'locked');
  });
});
