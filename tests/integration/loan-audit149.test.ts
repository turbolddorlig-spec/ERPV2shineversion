import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Role } from '@prisma/client';
import type { UserActor } from '@/lib/services/users';
import { resetDb } from '../helpers/reset';

let db: typeof import('@/lib/db').db;
let P: typeof import('@/lib/services/products');
let W: typeof import('@/lib/services/stock/warehouses');
let D: typeof import('@/lib/services/stock/docs');
let L: typeof import('@/lib/services/stock/loans');
let S: typeof import('@/lib/services/salary');
let V: typeof import('@/lib/services/stock/views');
beforeAll(async () => {
  db = (await import('@/lib/db')).db;
  P = await import('@/lib/services/products'); W = await import('@/lib/services/stock/warehouses');
  D = await import('@/lib/services/stock/docs'); L = await import('@/lib/services/stock/loans');
  S = await import('@/lib/services/salary'); V = await import('@/lib/services/stock/views');
});
let seq = 0;
let U: typeof import('@/lib/services/users');
let AppErrorCls: typeof import('@/lib/errors').AppError;
async function actor(roles: Role[]): Promise<UserActor> {
  seq++;
  const u = await db.user.create({ data: { phone: String(76000000 + seq), name: `${roles.join('+')} ${seq}`, roles, passwordHash: 'x' } });
  return { id: u.id, name: u.name, roles: u.roles, ip: '127.0.0.1' };
}
const key = () => randomUUID();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let sa: UserActor; let wh: UserActor; let acc: UserActor; let main: { id: number }; let v1: number; let cheap: number;
beforeEach(async () => {
  await resetDb(db as never);
  sa = await actor(['SUPER_ADMIN']); wh = await actor(['WAREHOUSE']); acc = await actor(['ACCOUNTING']);
  main = await W.createWarehouse(sa, { name: 'Төв' });
  const p = await P.createProduct(sa, { code: 'G1', name: 'Бараа', price: 10000, sizes: ['S'] });
  v1 = p.variants[0]!.id;
  const c = await P.createProduct(sa, { code: 'C1', name: 'Хямд', price: 4500, sizes: ['S'] });
  cheap = c.variants[0]!.id;
  await D.createReceipt(wh, { warehouseId: main.id, lines: [{ variantId: v1, qty: 50 }, { variantId: cheap, qty: 50 }], idemKey: key() });
});
beforeAll(async () => { U = await import('@/lib/services/users'); AppErrorCls = (await import('@/lib/errors')).AppError; });
async function err(p: Promise<unknown>, status: number, code?: string) {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(AppErrorCls); expect((e as InstanceType<typeof AppErrorCls>).status).toBe(status); if (code) expect((e as InstanceType<typeof AppErrorCls>).code).toBe(code); return; }
  throw new Error(`Алдаа гарах ёстой байсан (${status})`);
}
const recOk = async () => { const r = await V.reconcile(sa, { fresh: true }); expect(r.ok).toBe(true); expect(await db.stockBalance.count({ where: { qty: { lt: 0 } } })).toBe(0); };

/** Аудит #149 — бараа зээл: өөрийнхөө зээл, суутгал (16,000₮ доош бүтэн үнэ, үнийн заль), жолооч / ахлах жолооч, түгжээ */
describe('#149 бараа зээл', () => {
  it('өөрийнхөө зээлийг олгох, буцаах, суутгал засах боломжгүй; өөр хүн хийнэ', async () => {
    const mw = await actor(['MARKETING', 'WAREHOUSE']);
    const { loan } = await L.requestLoan(mw, { lines: [{ variantId: v1, qty: 3 }], idemKey: key() });
    await err(L.issueLoan(mw, loan.id, { warehouseId: main.id }), 403);
    await L.issueLoan(wh, loan.id, { warehouseId: main.id });
    await err(L.returnLoan(mw, loan.id, { warehouseId: main.id, lines: [{ variantId: v1, qty: 3 }], idemKey: key() }), 403);
    const ao = await actor(['ACCOUNTING', 'OPERATOR']);
    const { loan: l2 } = await L.requestLoan(ao, { lines: [{ variantId: v1, qty: 5 }], idemKey: key() });
    await L.issueLoan(wh, l2.id, { warehouseId: main.id });
    await err(L.setLoanDeduction(ao, l2.id, { variantId: v1, deduction: 0 }), 403);
    await err(L.setLoanDeduction(acc, l2.id, { variantId: v1, deduction: 999_999 }), 400, 'deduction_over');
    await recOk();
  });

  it('суутгал: 16,000₮-өөс доош бүтэн үнээр, түүнээс дээш үнэ − 5,000₮; үнийг түр бууруулсан ч хүсэлтийн үеийн үнээр', async () => {
    const op = await actor(['OPERATOR']);
    const big = (await P.createProduct(sa, { code: 'B1', name: 'Үнэтэй', price: 30000, sizes: ['S'] })).variants[0]!.id;
    await D.createReceipt(wh, { warehouseId: main.id, lines: [{ variantId: big, qty: 20 }], idemKey: key() });
    const { loan } = await L.requestLoan(op, { lines: [{ variantId: cheap, qty: 20 }, { variantId: big, qty: 2 }], idemKey: key() });
    // үнийг түр бууруулна
    const bp = await db.productVariant.findUniqueOrThrow({ where: { id: big }, select: { productId: true } });
    await db.product.update({ where: { id: bp.productId }, data: { price: 6000 } });
    const r = await L.issueLoan(wh, loan.id, { warehouseId: main.id });
    const m = Object.fromEntries(r.loan.lines.map((x) => [x.variantId, [x.unitPrice, x.deduction]]));
    expect(m[cheap]).toEqual([4500, 4500]);
    expect(m[big]).toEqual([30000, 25000]);
    const ch = await db.$transaction((tx) => L.chargeLoanTx(tx, acc, loan.id, 'x'));
    expect(ch.amount).toBe(20 * 4500 + 2 * 25000);
    await err(L.setLoanDiscount(sa, 16000), 400);
    await recOk();
  });

  it('жолооч, нийлүүлэгч зээлэхгүй; ахлах жолооч зээлнэ, цалингийн самбарт гарч суутгагдана', async () => {
    await err(L.requestLoan(await actor(['DRIVER']), { lines: [{ variantId: v1, qty: 1 }], idemKey: key() }), 403);
    await err(L.requestLoan(await actor(['OPERATOR', 'DRIVER']), { lines: [{ variantId: v1, qty: 1 }], idemKey: key() }), 403);
    const lead = await actor(['DRIVER_LEAD']);
    const { loan } = await L.requestLoan(lead, { lines: [{ variantId: v1, qty: 2 }], idemKey: key() });
    await L.issueLoan(wh, loan.id, { warehouseId: main.id });
    const ym = (await import('@/lib/ubdate')).ubDay().slice(0, 7);
    expect((await S.salaryBoard(acc, ym)).rows.some((r) => r.key === `u:${lead.id}`)).toBe(true);
    const half = Number((await import('@/lib/ubdate')).ubDay().slice(8)) <= 15 ? 1 : 2;
    const rec = await S.saveSalary(acc, { staffKey: `u:${lead.id}`, ym, half, baseSalary: 500_000, loanIds: [loan.id], version: 0 });
    expect(rec.loanTotal).toBe(2 * 10000);
    await S.lockSalary(acc, rec.id, rec.version);
    expect((await db.staffLoan.findUniqueOrThrow({ where: { id: loan.id } })).status).toBe('CLOSED');
    await recOk();
  });

  it('идэвхгүй болгоход хүсэлт цуцлагдана; цуцлагдсаныг «олгосон» гэж харуулахгүй; өөр хүний хүсэлтийг цуцлахад шалтгаан', async () => {
    const op = await actor(['OPERATOR']);
    const { loan } = await L.requestLoan(op, { lines: [{ variantId: v1, qty: 1 }], idemKey: key() });
    await U.deactivateUser(sa, op.id);
    expect((await db.staffLoan.findUniqueOrThrow({ where: { id: loan.id } })).status).toBe('CANCELLED');
    await err(L.issueLoan(wh, loan.id, { warehouseId: main.id }), 409, 'loan_decided');
    const op2 = await actor(['OPERATOR']);
    const { loan: l2 } = await L.requestLoan(op2, { lines: [{ variantId: v1, qty: 1 }], idemKey: key() });
    await err(L.cancelLoan(wh, l2.id, {}), 400);
    await L.cancelLoan(wh, l2.id, { note: 'Бараа дууссан' });
    expect((await L.listLoans(wh, { page: 1e18 })).page).toBe(10000);
  });

  it('цалин цоожлох ба зээл буцаах зэрэг — системийн алдаагүй, хуучин тоогоор суутгахгүй; тулгалт 0', async () => {
    const op = await actor(['OPERATOR']);
    const { loan } = await L.requestLoan(op, { lines: [{ variantId: v1, qty: 5 }], idemKey: key() });
    await L.issueLoan(wh, loan.id, { warehouseId: main.id });
    const ym = (await import('@/lib/ubdate')).ubDay().slice(0, 7);
    const half = Number((await import('@/lib/ubdate')).ubDay().slice(8)) <= 15 ? 1 : 2;
    const rec = await S.saveSalary(acc, { staffKey: `u:${op.id}`, ym, half, baseSalary: 500_000, loanIds: [loan.id], version: 0 });
    const [a, b] = await Promise.allSettled([
      S.lockSalary(acc, rec.id, rec.version),
      L.returnLoan(wh, loan.id, { warehouseId: main.id, lines: [{ variantId: v1, qty: 2 }], idemKey: key() }),
    ]);
    const http = await import('@/lib/http');
    for (const x of [a, b]) if (x.status === 'rejected') expect(http.errorResponse(x.reason).status).toBe(409);
    const l = await db.staffLoan.findUniqueOrThrow({ where: { id: loan.id }, include: { lines: true } });
    const line = l.lines[0]!;
    expect(line.returnedQty + line.chargedQty).toBeLessThanOrEqual(5);
    await recOk();
  });
});
