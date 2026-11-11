import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Role } from '@prisma/client';
import { AppError } from '@/lib/errors';
import type { UserActor } from '@/lib/services/users';
import { resetDb } from '../helpers/reset';

let db: typeof import('@/lib/db').db;
let P: typeof import('@/lib/services/products');
let W: typeof import('@/lib/services/stock/warehouses');
let D: typeof import('@/lib/services/stock/docs');
let T: typeof import('@/lib/services/stock/transfers');
let K: typeof import('@/lib/services/stock/counts');
let L: typeof import('@/lib/services/stock/loans');
let V: typeof import('@/lib/services/stock/views');

beforeAll(async () => {
  db = (await import('@/lib/db')).db;
  P = await import('@/lib/services/products');
  W = await import('@/lib/services/stock/warehouses');
  D = await import('@/lib/services/stock/docs');
  T = await import('@/lib/services/stock/transfers');
  K = await import('@/lib/services/stock/counts');
  L = await import('@/lib/services/stock/loans');
  V = await import('@/lib/services/stock/views');
});

let seq = 0;
async function actor(roles: Role[]): Promise<UserActor> {
  seq++;
  const u = await db.user.create({ data: { phone: String(75000000 + seq), name: `${roles.join('+')} ${seq}`, roles, passwordHash: 'x' } });
  return { id: u.id, name: u.name, roles: u.roles, ip: '127.0.0.1' };
}
async function err(p: Promise<unknown>, status: number, code?: string): Promise<AppError> {
  try { await p; } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).status).toBe(status);
    if (code) expect((e as AppError).code).toBe(code);
    return e as AppError;
  }
  throw new Error(`Алдаа гарах ёстой байсан (${status})`);
}
const key = () => randomUUID();
const N = 'Тестийн тайлбар';

let sa: UserActor; let wh: UserActor; let adm: UserActor;
let main: { id: number }; let w2: { id: number }; let w3: { id: number };
let v1: number; let v2: number; let shoeId: number;

async function qty(warehouseId: number, variantId: number) {
  const w = await db.warehouse.findUniqueOrThrow({ where: { id: warehouseId }, include: { location: true } });
  return (await db.stockBalance.findUnique({ where: { locationId_variantId: { locationId: w.location!.id, variantId } } }))?.qty ?? 0;
}
async function transitQty(variantId: number) {
  const t = await db.stockLocation.findFirstOrThrow({ where: { kind: 'TRANSIT' } });
  return (await db.stockBalance.findUnique({ where: { locationId_variantId: { locationId: t.id, variantId } } }))?.qty ?? 0;
}

beforeEach(async () => {
  await resetDb(db as never);
  sa = await actor(['SUPER_ADMIN']);
  adm = await actor(['ADMIN']);
  wh = await actor(['WAREHOUSE']);
  main = await W.createWarehouse(sa, { name: 'Төв агуулах' });
  w2 = await W.createWarehouse(sa, { name: 'Агуулах 2' });
  w3 = await W.createWarehouse(sa, { name: 'Агуулах 3' });
  const shoe = await P.createProduct(sa, { code: 'G1', name: 'Гутлын үдээс', price: 10000, sizes: ['S', 'L'] });
  shoeId = shoe.id;
  [v1, v2] = shoe.variants.map((v) => v.id) as [number, number];
});

describe('агуулах (#38)', () => {
  it('эхнийх нь үндсэн; үндсэнийг солих; үлдэгдэлтэйг хаахгүй; агуулах ажилтан үүсгэхгүй', async () => {
    const list = await W.listWarehouses(wh);
    expect(list.map((w) => [w.name, w.isPrimary])).toEqual([['Төв агуулах', true], ['Агуулах 2', false], ['Агуулах 3', false]]);
    await err(W.createWarehouse(wh, { name: 'Х' + 'агуулах' }), 403);
    await err(W.createWarehouse(sa, { name: 'Агуулах 2' }), 409, 'name_taken');
    await W.updateWarehouse(adm, w2.id, { isPrimary: true });
    expect((await W.primaryWarehouse())!.id).toBe(w2.id);
    await D.createReceipt(wh, { warehouseId: w3.id, lines: [{ variantId: v1, qty: 3 }], idemKey: key() });
    await err(W.updateWarehouse(sa, w3.id, { isActive: false }), 400, 'warehouse_not_empty');
    await err(W.updateWarehouse(sa, w2.id, { isActive: false }), 400);
    await W.updateWarehouse(sa, main.id, { isActive: false });
    expect((await W.listWarehouses(sa)).map((w) => w.id)).not.toContain(main.id);
  });
});

describe('орлого, зарлага', () => {
  it('орлого нэмнэ; давхар дарахад нэг; зарлага тайлбар заавал; сөрөг гарахгүй', async () => {
    const k = key();
    const a = await D.createReceipt(wh, { warehouseId: main.id, lines: [{ variantId: v1, qty: 10 }, { variantId: v1, qty: 5 }, { variantId: v2, qty: 2 }], note: 'Батаас ирсэн', idemKey: k });
    const b = await D.createReceipt(wh, { warehouseId: main.id, lines: [{ variantId: v1, qty: 10 }], idemKey: k });
    expect(b.duplicate).toBe(true);
    expect(b.receipt.id).toBe(a.receipt.id);
    expect(await qty(main.id, v1)).toBe(15);
    await err(D.createReceipt(wh, { warehouseId: main.id, lines: [{ variantId: v1, qty: -1 }], idemKey: key() }), 400, 'bad_qty');
    await err(D.createReceipt(wh, { warehouseId: main.id, lines: [{ variantId: 99999, qty: 1 }], idemKey: key() }), 400, 'variant_not_found');
    await err(D.createReceipt(await actor(['OPERATOR']), { warehouseId: main.id, lines: [{ variantId: v1, qty: 1 }], idemKey: key() }), 403);
    await err(D.createIssue(wh, { warehouseId: main.id, reason: 'DAMAGE', lines: [{ variantId: v1, qty: 1 }], note: 'ab', idemKey: key() }), 400, 'reason_required');
    await err(D.createIssue(wh, { warehouseId: main.id, reason: 'GIFT', lines: [{ variantId: v1, qty: 1 }], note: N, idemKey: key() }), 400, 'reason_type');
    await D.createIssue(wh, { warehouseId: main.id, reason: 'DAMAGE', lines: [{ variantId: v1, qty: 4 }], note: 'Хайрцаг нь норгосон', idemKey: key() });
    expect(await qty(main.id, v1)).toBe(11);
    const e = await err(D.createIssue(wh, { warehouseId: main.id, reason: 'SAMPLE', lines: [{ variantId: v1, qty: 12 }], note: N, idemKey: key() }), 409, 'insufficient_stock');
    expect(e.message).toMatch(/байгаа 11, гаргах 12/);
    expect(await qty(main.id, v1)).toBe(11);
  });

  it('2 хүн зэрэг сүүлийн барааг гаргавал нэг нь л амжилттай; үлдэгдэл сөрөг болохгүй', async () => {
    await D.createReceipt(wh, { warehouseId: main.id, lines: [{ variantId: v1, qty: 5 }], idemKey: key() });
    const tries = await Promise.allSettled(Array.from({ length: 6 }, () => D.createIssue(wh, { warehouseId: main.id, reason: 'SAMPLE', lines: [{ variantId: v1, qty: 3 }], note: N, idemKey: key() })));
    expect(tries.filter((t) => t.status === 'fulfilled')).toHaveLength(1);
    expect(await qty(main.id, v1)).toBe(2);
    await expect(db.$executeRawUnsafe(`UPDATE "StockBalance" SET qty = -1`)).rejects.toThrow(/nonneg/);
  });

  it('журналыг засах, устгах боломжгүй', async () => {
    await D.createReceipt(wh, { warehouseId: main.id, lines: [{ variantId: v1, qty: 1 }], idemKey: key() });
    await expect(db.$executeRawUnsafe(`UPDATE "StockMove" SET qty = 100`)).rejects.toThrow(/append-only/);
    await expect(db.$executeRawUnsafe(`DELETE FROM "StockMove"`)).rejects.toThrow(/append-only/);
  });
});

describe('шилжүүлэг 2 алхам (#38)', () => {
  beforeEach(async () => {
    await D.createReceipt(wh, { warehouseId: w2.id, lines: [{ variantId: v1, qty: 50 }, { variantId: v2, qty: 20 }], idemKey: key() });
  });
  it('илгээхэд замдаа; бүтэн хүлээн авбал RECEIVED; давтан хүлээн авахад нэг', async () => {
    const { transfer } = await T.sendTransfer(wh, { fromWarehouseId: w2.id, toWarehouseId: main.id, lines: [{ variantId: v1, qty: 30 }], idemKey: key() });
    expect(await qty(w2.id, v1)).toBe(20);
    expect(await transitQty(v1)).toBe(30);
    expect(await qty(main.id, v1)).toBe(0);
    const [a, b] = await Promise.all([
      T.receiveTransfer(wh, transfer.id, { lines: [{ variantId: v1, receivedQty: 30 }] }),
      T.receiveTransfer(wh, transfer.id, { lines: [{ variantId: v1, receivedQty: 30 }] }),
    ]);
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);
    expect(await qty(main.id, v1)).toBe(30);
    expect(await transitQty(v1)).toBe(0);
    expect((await T.getTransfer(wh, transfer.id)).status).toBe('RECEIVED');
  });
  it('дутуу ирвэл DISCREPANCY → админ: нэгийг нь буцаах, нөгөөг нь хорогдол', async () => {
    const { transfer } = await T.sendTransfer(wh, { fromWarehouseId: w2.id, toWarehouseId: main.id, lines: [{ variantId: v1, qty: 10 }, { variantId: v2, qty: 5 }], idemKey: key() });
    await err(T.receiveTransfer(wh, transfer.id, { lines: [{ variantId: v1, receivedQty: 11 }, { variantId: v2, receivedQty: 5 }] }), 400, 'bad_qty');
    await err(T.receiveTransfer(wh, transfer.id, { lines: [{ variantId: v1, receivedQty: 10 }] }), 400, 'missing_lines');
    const r = await T.receiveTransfer(wh, transfer.id, { lines: [{ variantId: v1, receivedQty: 8 }, { variantId: v2, receivedQty: 4 }] });
    expect(r.transfer.status).toBe('DISCREPANCY');
    expect(await transitQty(v1)).toBe(2);
    await err(T.resolveTransfer(wh, transfer.id, { decisions: 'loss', note: N }), 403);
    await err(T.resolveTransfer(adm, transfer.id, { decisions: [{ variantId: v1, action: 'return' }], note: N }), 400, 'missing_lines');
    await T.resolveTransfer(adm, transfer.id, { decisions: [{ variantId: v1, action: 'return' }, { variantId: v2, action: 'loss' }], note: 'Замд алдагдсан' });
    expect(await qty(w2.id, v1)).toBe(40 + 2);
    expect(await qty(w2.id, v2)).toBe(15);
    expect(await transitQty(v1)).toBe(0);
    expect(await transitQty(v2)).toBe(0);
    expect((await T.getTransfer(adm, transfer.id)).status).toBe('RESOLVED');
  });
  it('хүлээн аваагүйг цуцлахад илгээгч рүү буцна; хүлээн авсныг цуцлахгүй; хүрэхгүй бол илгээхгүй', async () => {
    const { transfer } = await T.sendTransfer(wh, { fromWarehouseId: w2.id, toWarehouseId: w3.id, lines: [{ variantId: v1, qty: 7 }], idemKey: key() });
    await T.cancelTransfer(wh, transfer.id, { note: 'Буруу агуулах сонгосон' });
    expect(await qty(w2.id, v1)).toBe(50);
    await err(T.receiveTransfer(wh, transfer.id, { lines: [{ variantId: v1, receivedQty: 7 }] }), 409, 'transfer_cancelled');
    await err(T.sendTransfer(wh, { fromWarehouseId: w2.id, toWarehouseId: main.id, lines: [{ variantId: v1, qty: 51 }], idemKey: key() }), 409, 'insufficient_stock');
    await err(T.sendTransfer(wh, { fromWarehouseId: w2.id, toWarehouseId: w2.id, lines: [{ variantId: v1, qty: 1 }], idemKey: key() }), 400);
  });
});

describe('тооллого (#38)', () => {
  it('тоолох → илгээх → админ тус бүр / бүгдийг батлах; зөрүү журналд; тоолсны дараа хөдөлсөн бол тэмдэглэнэ', async () => {
    await D.createReceipt(wh, { warehouseId: main.id, lines: [{ variantId: v1, qty: 10 }, { variantId: v2, qty: 10 }], idemKey: key() });
    await err(K.startCount(wh, { warehouseId: main.id, note: 'ab' }), 400, 'reason_required');
    const c = await K.startCount(wh, { warehouseId: main.id, note: 'Сарын тооллого' });
    await err(K.startCount(wh, { warehouseId: main.id, note: 'Дахин тооллого' }), 409, 'count_open');
    await K.setCountLine(wh, c.id, { variantId: v1, countedQty: 7 });
    await K.setCountLine(wh, c.id, { variantId: v2, countedQty: 12 });
    await K.setCountLine(wh, c.id, { variantId: v2, countedQty: 13 });
    // тоолсны дараа v1 хөдөлсөн
    await D.createIssue(wh, { warehouseId: main.id, reason: 'SAMPLE', lines: [{ variantId: v1, qty: 1 }], note: N, idemKey: key() });
    await err(K.decideCount(adm, c.id, { lineIds: 'all', action: 'approve' }), 409, 'count_not_submitted');
    await K.submitCount(wh, c.id);
    await err(K.setCountLine(wh, c.id, { variantId: v1, countedQty: 1 }), 409, 'count_locked');
    const detail = await K.getCount(adm, c.id);
    expect(detail.lines.find((l) => l.variantId === v1)).toMatchObject({ systemQty: 10, countedQty: 7, diff: -3, movedSince: true });
    await err(K.decideCount(wh, c.id, { lineIds: 'all', action: 'approve' }), 403);
    const l2 = detail.lines.find((l) => l.variantId === v2)!;
    await K.decideCount(adm, c.id, { lineIds: [l2.id], action: 'approve' });
    expect(await qty(main.id, v2)).toBe(13);
    const r = await K.decideCount(adm, c.id, { lineIds: 'all', action: 'approve' });
    expect(r.closed).toBe(true);
    expect(await qty(main.id, v1)).toBe(10 - 1 - 3);
    await K.decideCount(adm, c.id, { lineIds: 'all', action: 'approve' }).catch(() => undefined);
    expect(await qty(main.id, v1)).toBe(6);
    const moves = await db.stockMove.findMany({ where: { docType: 'count', docId: c.id }, orderBy: { id: 'asc' } });
    expect(moves.map((m) => [m.type, m.qty])).toEqual([['COUNT_PLUS', 3], ['COUNT_MINUS', 3]]);
  });
});

describe('бараа зээл (#38)', () => {
  it('хүсэлт → олгох → хэсэгчилсэн буцаалт → үлдсэнийг цалингаас (үнэ − хямдрал)', async () => {
    await D.createReceipt(wh, { warehouseId: main.id, lines: [{ variantId: v1, qty: 10 }], idemKey: key() });
    const mk = await actor(['MARKETING']);
    const acc = await actor(['ACCOUNTING']);
    await err(L.requestLoan(wh, { lines: [{ variantId: v1, qty: 1 }], idemKey: key() }), 403);
    const k = key();
    const { loan } = await L.requestLoan(mk, { lines: [{ variantId: v1, qty: 3 }], note: 'Зураг авалтад', idemKey: k });
    expect((await L.requestLoan(mk, { lines: [{ variantId: v1, qty: 3 }], idemKey: k })).duplicate).toBe(true);
    expect(await qty(main.id, v1)).toBe(10);
    await err(L.issueLoan(mk, loan.id, { warehouseId: main.id }), 403);
    await L.issueLoan(wh, loan.id, { warehouseId: main.id });
    expect(await qty(main.id, v1)).toBe(7);
    let l = await L.getLoan(mk, loan.id);
    expect(l.lines[0]).toMatchObject({ qty: 3, unitPrice: 10000, deduction: 5000, outstanding: 3 });
    // хэсэгчилсэн буцаалт; давхар дарахад нэг
    const rk = key();
    await Promise.all([1, 2].map(() => L.returnLoan(wh, loan.id, { warehouseId: main.id, lines: [{ variantId: v1, qty: 1 }], idemKey: rk })));
    expect(await qty(main.id, v1)).toBe(8);
    await err(L.returnLoan(wh, loan.id, { warehouseId: main.id, lines: [{ variantId: v1, qty: 3 }], idemKey: key() }), 400, 'bad_qty');
    // хямдрал / суутгал засах — СА, нягтлан
    await err(L.setLoanDeduction(wh, loan.id, { variantId: v1, deduction: 4000 }), 403);
    await L.setLoanDeduction(acc, loan.id, { variantId: v1, deduction: 4000 });
    await err(L.chargeLoan(wh, loan.id, {}), 403);
    const ch = await L.chargeLoan(acc, loan.id, { note: '11-р сарын цалингаас' });
    expect(ch.amount).toBe(2 * 4000);
    l = await L.getLoan(mk, loan.id);
    expect(l).toMatchObject({ status: 'CLOSED', outstandingQty: 0 });
    // ажилтны гарт юу ч үлдээгүй, нийт: 10 − 3 + 1 = 8 агуулахад, 2 цалингаар
    const staffLoc = await db.stockLocation.findFirstOrThrow({ where: { kind: 'STAFF', userId: mk.id } });
    expect((await db.stockBalance.findUnique({ where: { locationId_variantId: { locationId: staffLoc.id, variantId: v1 } } }))?.qty).toBe(0);
  });
  it('хямдралын тохиргоо; ажилтан зөвхөн өөрийнхөө зээлийг харна; татгалзах, цуцлах', async () => {
    const op = await actor(['OPERATOR']);
    const op2 = await actor(['OPERATOR']);
    const acc = await actor(['ACCOUNTING']);
    await err(L.setLoanDiscount(wh, 3000), 403);
    await L.setLoanDiscount(acc, 3000);
    expect(await L.getLoanDiscount()).toBe(3000);
    const a = await L.requestLoan(op, { lines: [{ variantId: v1, qty: 1 }], idemKey: key() });
    await L.requestLoan(op2, { lines: [{ variantId: v2, qty: 1 }], idemKey: key() });
    expect((await L.listLoans(op, {})).items.map((x) => x.staffName)).toEqual([op.name]);
    expect((await L.listLoans(wh, {})).total).toBe(2);
    await err(L.getLoan(op2, a.loan.id), 403);
    await err(L.rejectLoan(wh, a.loan.id, { note: 'ab' }), 400, 'reason_required');
    await L.rejectLoan(wh, a.loan.id, { note: 'Агуулахад байхгүй' });
    await err(L.issueLoan(wh, a.loan.id, { warehouseId: main.id }), 409);
  });
});

describe('дүүргэлт, өнөөдрийн ажил, түүх, тулгалт (#39)', () => {
  it('захиалгын хэрэгцээ тавиураас их бол анхааруулга, санал, нэг товчоор шилжүүлэг', async () => {
    await D.createReceipt(wh, { warehouseId: main.id, lines: [{ variantId: v1, qty: 20 }], idemKey: key() });
    await D.createReceipt(wh, { warehouseId: w2.id, lines: [{ variantId: v1, qty: 30 }], idemKey: key() });
    await D.createReceipt(wh, { warehouseId: w3.id, lines: [{ variantId: v1, qty: 40 }], idemKey: key() });
    // Модуль 3-ын захиалгыг дуурайна: 70 ширхэг нөөцлөгдсөн
    await db.stockReservation.createMany({ data: Array.from({ length: 70 }, (_, i) => ({ ref: `O${i}`, variantId: v1, qty: 1 })) });
    let r = await V.refillList(wh);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ demand: 70, onShelf: 20, shortage: 50, toSend: 50, uncovered: 0 });
    expect(r.items[0]!.suggest.map((s) => [s.name, s.take])).toEqual([['Агуулах 3', 40], ['Агуулах 2', 10]]);
    expect((await V.todayWork(wh, { fresh: true })).refill).toBe(1);
    // нэг товч: агуулах бүрээс нэг шилжүүлэг
    const sent = [];
    for (const p of r.plan) sent.push((await T.sendTransfer(wh, { fromWarehouseId: p.warehouseId, toWarehouseId: main.id, lines: p.lines, refill: true, idemKey: key() })).transfer);
    r = await V.refillList(wh);
    expect(r.items[0]).toMatchObject({ incoming: 50, toSend: 0 });
    const t = await V.todayWork(wh);
    expect(t.incoming).toBe(2);
    for (const s of sent) {
      const d = await T.getTransfer(wh, s.id);
      await T.receiveTransfer(wh, s.id, { lines: d.lines.map((l) => ({ variantId: l.variantId, receivedQty: l.sentQty })) });
    }
    expect((await V.refillList(wh)).items).toHaveLength(0);
    expect(await qty(main.id, v1)).toBe(70);
  });

  it('барааны түүх: бүх төрлийн хөдөлгөөн, нийлбэр, одоо хаана; тулгалт = 0 зөрүү; үлдэгдлийн жагсаалт', async () => {
    const mk = await actor(['MARKETING']);
    await D.createReceipt(wh, { warehouseId: main.id, lines: [{ variantId: v1, qty: 10 }], idemKey: key() });
    await D.createIssue(wh, { warehouseId: main.id, reason: 'DAMAGE', lines: [{ variantId: v1, qty: 1 }], note: N, idemKey: key() });
    const { loan } = await L.requestLoan(mk, { lines: [{ variantId: v1, qty: 2 }], idemKey: key() });
    await L.issueLoan(wh, loan.id, { warehouseId: main.id });
    await T.sendTransfer(wh, { fromWarehouseId: main.id, toWarehouseId: w2.id, lines: [{ variantId: v1, qty: 3 }], idemKey: key() });
    const h = await V.productStockHistory(wh, shoeId, {});
    expect(h.history.items.map((m) => m.type)).toEqual(['TRANSFER_SEND', 'LOAN_OUT', 'ISSUE', 'RECEIPT']);
    expect(Object.fromEntries(h.summary.map((s) => [s.type, s.qty]))).toMatchObject({ RECEIPT: 10, ISSUE: 1, LOAN_OUT: 2, TRANSFER_SEND: 3 });
    expect(h.whereNow.map((w) => [w.kind, w.qty]).sort()).toEqual([['STAFF', 2], ['TRANSIT', 3], ['WAREHOUSE', 4]]);
    const rec = await V.reconcile(adm, { fresh: true });
    expect(rec.ok).toBe(true);
    const list = await V.stockList(wh, { q: 'үдээс' });
    const row = list.items.find((i) => i.variantId === v1)!;
    expect(row).toMatchObject({ total: 4, transit: 3, staff: 2 });
    expect(row.byWarehouse[main.id]).toBe(4);
    // Модуль 1-ийн жагсаалтад үлдэгдэл
    const pl = await P.listProducts(mk, {});
    expect(pl.items.find((i) => i.id === shoeId)!.stock).toEqual({ total: 4, available: 4, driver: 0 });
    await err(V.stockList(mk, {}), 403);
    await err(V.reconcile(wh, { fresh: true }), 403);
  });

  it('тавиур: олон барааг нэг дор; буруу код татгалзана; тавиурын дарааллаар эрэмбэлнэ', async () => {
    const b = await P.createProduct(sa, { code: 'B1', name: 'Бүс', price: 5000 });
    await V.setShelf(wh, { productIds: [shoeId], shelfCode: 'b-2' });
    await V.setShelf(wh, { productIds: [b.id], shelfCode: 'A-1' });
    await err(V.setShelf(wh, { productIds: [b.id], shelfCode: 'хэт урт тавиурын код' }), 400, 'bad_shelf');
    await err(V.setShelf(await actor(['MARKETING']), { productIds: [b.id], shelfCode: 'A' }), 403);
    const list = await V.stockList(wh, { sort: 'shelf' });
    expect(list.items.map((i) => i.shelfCode)).toEqual(['A-1', 'B-2', 'B-2']);
  });
});
