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

let sa: UserActor; let wh: UserActor; let wh2: UserActor; let adm: UserActor;
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
  wh2 = await actor(['WAREHOUSE']); // #143: шилжүүлгийг илгээсэн хүн өөрөө хүлээн авахгүй
  main = await W.createWarehouse(sa, { name: 'Төв агуулах' });
  w2 = await W.createWarehouse(sa, { name: 'Агуулах 2' });
  w3 = await W.createWarehouse(sa, { name: 'Агуулах 3' });
  const shoe = await P.createProduct(sa, { code: 'G1', name: 'Гутлын үдээс', price: 10000, sizes: ['S', 'L'] });
  shoeId = shoe.id;
  [v1, v2] = shoe.variants.map((v) => v.id) as [number, number];
});


/** Аудит #143 — агуулахын эрсдэлүүдийн засвар */
describe('#143 агуулах: архив, зарлага хянах, шилжүүлэг, тооллого, түгжээ', () => {
  it('архивласан / идэвхгүй бараанд орлого, шилжүүлэг хийхгүй; үлдэгдэлтэй архив жагсаалтад харагдана', async () => {
    await D.createReceipt(wh, { warehouseId: main.id, lines: [{ variantId: v1, qty: 5 }], idemKey: key() });
    await err(P.setProductStatus(sa, shoeId, { status: 'ARCHIVED', reason: 'Зарагдахаа больсон', version: (await db.product.findUniqueOrThrow({ where: { id: shoeId } })).version }), 409, 'has_stock');
    // хуучин өгөгдөл: үлдэгдэлтэй архив
    await db.product.update({ where: { id: shoeId }, data: { status: 'ARCHIVED' } });
    await err(D.createReceipt(wh, { warehouseId: main.id, lines: [{ variantId: v1, qty: 50 }], idemKey: key() }), 400, 'inactive_variant');
    await err(T.sendTransfer(wh, { fromWarehouseId: main.id, toWarehouseId: w2.id, lines: [{ variantId: v1, qty: 1 }], idemKey: key() }), 400, 'inactive_variant');
    const list = await V.stockList(wh, {});
    expect(list.items.some((x) => x.variantId === v1)).toBe(true); // нуугдахгүй
    // зарлагаар цэвэрлэж болно
    await D.createIssue(wh, { warehouseId: main.id, reason: 'DAMAGE', note: 'Архивын үлдэгдэл цэвэрлэв', lines: [{ variantId: v1, qty: 5 }], idemKey: key() });
    expect((await V.stockList(wh, {})).items.some((x) => x.variantId === v1)).toBe(false);
    expect((await V.reconcile(sa, { fresh: true })).ok).toBe(true);
  });

  it('зарлага шууд гарна; Супер админ / Админ үнийн дүнтэй жагсаалтаар хянана; агуулах хянахгүй', async () => {
    await D.createReceipt(wh, { warehouseId: main.id, lines: [{ variantId: v1, qty: 10 }], idemKey: key() });
    const i = await D.createIssue(wh, { warehouseId: main.id, reason: 'DAMAGE', note: 'Гэмтэлтэй ирсэн', lines: [{ variantId: v1, qty: 3 }], idemKey: key() });
    await err(D.listIssues(wh, {}), 403);
    const l = await D.listIssues(adm, {});
    expect(l.pendingCount).toBe(1);
    expect(l.items[0]).toMatchObject({ id: i.issue.id, pieces: 3, value: 30000, createdByName: wh.name });
    expect((await V.todayWork(adm, { fresh: true })).issuesToReview).toBe(1);
    await err(D.reviewIssues(wh, { ids: [i.issue.id] }), 403);
    await D.reviewIssues(adm, { ids: [i.issue.id] });
    expect((await D.listIssues(adm, {})).pendingCount).toBe(0);
    expect((await D.listIssues(adm, { status: 'reviewed' })).items[0]!.reviewedByName).toBe(adm.name);
  });

  it('шилжүүлгийг илгээсэн хүн өөрөө хүлээн авч болно (эзний шийдвэр — агуулахыг найдвартай хүн хариуцна)', async () => {
    await D.createReceipt(wh, { warehouseId: main.id, lines: [{ variantId: v1, qty: 10 }], idemKey: key() });
    const { transfer } = await T.sendTransfer(wh, { fromWarehouseId: main.id, toWarehouseId: w2.id, lines: [{ variantId: v1, qty: 10 }], idemKey: key() });
    await T.receiveTransfer(wh, transfer.id, { lines: [{ variantId: v1, receivedQty: 10 }] });
    expect((await V.reconcile(sa, { fresh: true })).ok).toBe(true);
  });

  it('тооллого эхэлснээс хойш хөдөлсөн мөр «хөдөлсөн» тэмдэгтэй, «бүгдийг батлах»-д орохгүй (хуурамч үлдэгдэлгүй)', async () => {
    await D.createReceipt(wh, { warehouseId: main.id, lines: [{ variantId: v1, qty: 10 }, { variantId: v2, qty: 4 }], idemKey: key() });
    const c = await K.startCount(wh, { warehouseId: main.id, note: 'Сарын тооллого' });
    // цаасан дээр 10 гэж тоолсон, дараа нь 3-ыг зарлагадсан, тэгээд 10 гэж оруулав
    await D.createIssue(wh, { warehouseId: main.id, reason: 'SAMPLE', note: 'Дээж гаргав', lines: [{ variantId: v1, qty: 3 }], idemKey: key() });
    await K.setCountLine(wh, c.id, { variantId: v1, countedQty: 10 });
    await K.setCountLine(wh, c.id, { variantId: v2, countedQty: 3 });
    await K.submitCount(wh, c.id);
    const det = await K.getCount(adm, c.id);
    expect(det.lines.find((l) => l.variantId === v1)!.movedSince).toBe(true);
    expect(det.lines.find((l) => l.variantId === v2)!.movedSince).toBe(false);
    const r = await K.decideCount(adm, c.id, { lineIds: 'all', action: 'approve' });
    expect([r.decided, (r as { skippedMoved?: number }).skippedMoved]).toEqual([1, 1]);
    const loc = (await db.stockLocation.findUniqueOrThrow({ where: { warehouseId: main.id } })).id;
    const bal = async (v: number) => (await db.stockBalance.findUnique({ where: { locationId_variantId: { locationId: loc, variantId: v } } }))?.qty ?? 0;
    expect([await bal(v1), await bal(v2)]).toEqual([7, 3]); // v1 хуурамчаар 10 болоогүй
    expect((await V.reconcile(sa, { fresh: true })).ok).toBe(true);
  });

  it('эсрэг чиглэлийн зэрэг шилжүүлэг (илгээх ↔ хүлээн авах) алдаагүй, тулгалт 0', async () => {
    await D.createReceipt(wh, { warehouseId: main.id, lines: [{ variantId: v1, qty: 100 }], idemKey: key() });
    await D.createReceipt(wh, { warehouseId: w2.id, lines: [{ variantId: v1, qty: 100 }], idemKey: key() });
    const sent = [];
    for (let i = 0; i < 10; i++) sent.push((await T.sendTransfer(wh, { fromWarehouseId: w2.id, toWarehouseId: main.id, lines: [{ variantId: v1, qty: 1 }], idemKey: key() })).transfer.id);
    const res = await Promise.allSettled([
      ...sent.map((id) => T.receiveTransfer(wh2, id, { lines: [{ variantId: v1, receivedQty: 1 }] })),
      ...Array.from({ length: 10 }, () => T.sendTransfer(wh, { fromWarehouseId: main.id, toWarehouseId: w2.id, lines: [{ variantId: v1, qty: 1 }], idemKey: key() })),
    ]);
    expect(res.filter((x) => x.status === 'rejected')).toEqual([]);
    expect((await V.reconcile(sa, { fresh: true })).ok).toBe(true);
  });

  it('барааны сонголтод 50-аас олон мөрийн үлдэгдэл харагдана', async () => {
    const prods = [];
    for (let i = 0; i < 30; i++) prods.push(await P.createProduct(sa, { code: `X${i}`, name: `Бараа ${i}`, price: 1000, sizes: ['S', 'L'] }));
    const vids = prods.flatMap((p) => p.variants.map((v) => v.id));
    expect(vids.length).toBe(60);
    const l = await V.stockList(wh, { ids: vids });
    expect(l.items.length).toBe(60);
  });
});
