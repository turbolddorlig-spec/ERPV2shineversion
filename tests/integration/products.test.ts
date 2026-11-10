import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import sharp from 'sharp';
import type { Role } from '@prisma/client';
import { AppError } from '@/lib/errors';
import type { UserActor } from '@/lib/services/users';

let db: typeof import('@/lib/db').db;
let P: typeof import('@/lib/services/products');
let C: typeof import('@/lib/services/catalog');
let I: typeof import('@/lib/services/product-images');
let H: typeof import('@/lib/services/product-history');
let UPLOAD_DIR: string;

beforeAll(async () => {
  process.env.UPLOAD_DIR = await mkdtemp(path.join(os.tmpdir(), 'erp-uploads-'));
  db = (await import('@/lib/db')).db;
  P = await import('@/lib/services/products');
  C = await import('@/lib/services/catalog');
  I = await import('@/lib/services/product-images');
  H = await import('@/lib/services/product-history');
  UPLOAD_DIR = (await import('@/lib/storage')).UPLOAD_DIR;
});

let seq = 0;
async function actor(roles: Role[]): Promise<UserActor> {
  seq++;
  const u = await db.user.create({ data: { phone: String(76000000 + seq), name: `${roles.join('+')} ${seq}`, roles, passwordHash: 'x' } });
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

const png = (w = 1200, h = 900) => sharp({ create: { width: w, height: h, channels: 3, background: '#e8590c' } }).png().toBuffer();
const R = 'Нийлүүлэгч үнэ өсгөсөн';

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE "ProductImage", "ProductVariant", "Product", "Category", "Season", "AuditReview", "Session", "User" RESTART IDENTITY CASCADE');
  // Зөвхөн ТЕСТИЙН database: түүхийн хамгаалалтыг түр унтрааж цэвэрлэнэ (production-д хэзээ ч хийхгүй)
  await db.$transaction([
    db.$executeRawUnsafe('ALTER TABLE "AuditLog" DISABLE TRIGGER USER'),
    db.$executeRawUnsafe('TRUNCATE "AuditLog"'),
    db.$executeRawUnsafe('ALTER TABLE "AuditLog" ENABLE TRIGGER USER'),
  ]);
});

describe('бараа үүсгэх', () => {
  it('өнгө/хэмжээгүй бараа → нэг үндсэн хувилбар', async () => {
    const a = await actor(['MARKETING']);
    const p = await P.createProduct(a, { code: '0412', name: 'Кашемир ороолт', price: 165000 });
    expect(p.variants).toHaveLength(1);
    expect(p.variants[0]).toMatchObject({ code: '0412', color: '', size: '', label: 'Үндсэн', price: 165000 });
  });
  it('өнгө × хэмжээ → бүх хослол, код автомат', async () => {
    const a = await actor(['ADMIN']);
    const p = await P.createProduct(a, { code: '0887', name: 'Цагаан пүүз', price: 195000, costPrice: 110000, colors: ['Цагаан', 'Хар'], sizes: ['37', '38'] });
    expect(p.variants.map((v) => v.code)).toEqual(['0887-ЦАГААН-37', '0887-ЦАГААН-38', '0887-ХАР-37', '0887-ХАР-38']);
    expect(p.costPrice).toBe(110000);
  });
  it('давхар код → 409; зэрэг 5 хүсэлт → яг 1', async () => {
    const a = await actor(['MARKETING']);
    await P.createProduct(a, { code: 'A1', name: 'Нэг', price: 1000 });
    await err(P.createProduct(a, { code: 'a1', name: 'Хоёр', price: 1000 }), 409, 'code_taken');
    const r = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => P.createProduct(a, { code: 'B2', name: `Зэрэг ${i}`, price: 1000 })));
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  });
  it('буруу өгөгдөл', async () => {
    const a = await actor(['MARKETING']);
    await err(P.createProduct(a, { code: 'X 1', name: 'Зайтай код', price: 1000 }), 400);
    await err(P.createProduct(a, { code: 'X1', name: 'А', price: 1000 }), 400);
    await err(P.createProduct(a, { code: 'X1', name: 'Үнэгүй', price: 0 }), 400);
    await err(P.createProduct(a, { code: 'X1', name: 'Сөрөг', price: -5 }), 400);
    await err(P.createProduct(a, { code: 'X1', name: 'Бутархай', price: 10.5 }), 400);
    await err(P.createProduct(a, { code: 'X1', name: 'Ангилалгүй', price: 1000, categoryId: 999 }), 400);
  });
  it('маркетинг өртөг оруулж чадахгүй; оператор, торгууль бараа үүсгэхгүй', async () => {
    await err(P.createProduct(await actor(['MARKETING']), { code: 'C1', name: 'Өртөгтэй', price: 1000, costPrice: 500 }), 403);
    await err(P.createProduct(await actor(['OPERATOR']), { code: 'C2', name: 'Оператор', price: 1000 }), 403);
    await err(P.createProduct(await actor(['PENALTY_OFFICER']), { code: 'C3', name: 'Торгууль', price: 1000 }), 403);
  });
});

describe('засвар — тайлбар заавал (#29)', () => {
  it('тайлбаргүй / 5-аас богино → reason_required, админ ч бас', async () => {
    const adm = await actor(['SUPER_ADMIN']);
    const p = await P.createProduct(adm, { code: 'D1', name: 'Бараа', price: 1000 });
    await err(P.updateProduct(adm, p.id, { price: 2000 }, { reason: '', version: p.version }), 400, 'reason_required');
    await err(P.updateProduct(adm, p.id, { price: 2000 }, { reason: 'аа  бб', version: p.version }), 400, 'reason_required');
    const r = await P.updateProduct(adm, p.id, { price: 2000 }, { reason: R, version: p.version });
    expect(r.product.price).toBe(2000);
  });
  it('түүхэнд хэн, хуучин→шинэ, тайлбар, "price" тэмдэг', async () => {
    const mk = await actor(['MARKETING']);
    const p = await P.createProduct(mk, { code: 'D2', name: 'Бараа', price: 1000 });
    await P.updateProduct(mk, p.id, { price: 1500, name: 'Шинэ нэр' }, { reason: R, version: p.version });
    const h = await H.listProductHistory(mk, { productId: p.id });
    const e = h.items.find((i) => i.action === 'product.updated')!;
    expect(e.actorName).toBe(mk.name);
    expect(e.important).toBe(true);
    expect(e.details).toMatchObject({ reason: R, changes: { price: { from: 1000, to: 1500 }, name: { from: 'Бараа', to: 'Шинэ нэр' } } });
  });
  it('зэрэг 2 хүн засвал хоёр дахь нь "stale" — чимээгүй дарахгүй', async () => {
    const a = await actor(['MARKETING']);
    const b = await actor(['MARKETING']);
    const p = await P.createProduct(a, { code: 'D3', name: 'Бараа', price: 1000 });
    await P.updateProduct(a, p.id, { price: 1100 }, { reason: R, version: p.version });
    await err(P.updateProduct(b, p.id, { price: 1200 }, { reason: R, version: p.version }), 409, 'stale');
  });
  it('өөрчлөлтгүй хадгалахад түүх бичигдэхгүй', async () => {
    const a = await actor(['MARKETING']);
    const p = await P.createProduct(a, { code: 'D4', name: 'Бараа', price: 1000 });
    const r = await P.updateProduct(a, p.id, { price: 1000 }, { reason: R, version: p.version });
    expect(r.changed).toBe(false);
  });
  it('код солих: зөвхөн админ; хувилбарын код дагаж солигдоно', async () => {
    const mk = await actor(['MARKETING']);
    const adm = await actor(['ADMIN']);
    const p = await P.createProduct(adm, { code: 'OLD', name: 'Пүүз', price: 1000, colors: ['Хар'], sizes: ['38'] });
    await err(P.updateProduct(mk, p.id, { code: 'NEW' }, { reason: R, version: p.version }), 403);
    const r = await P.updateProduct(adm, p.id, { code: 'NEW' }, { reason: 'Кодын алдаа засав', version: p.version });
    expect(r.product.code).toBe('NEW');
    expect(r.product.variants[0]!.code).toBe('NEW-ХАР-38');
  });
  it('өртөг: маркетинг харахгүй (get, list, түүх)', async () => {
    const adm = await actor(['ADMIN']);
    const mk = await actor(['MARKETING']);
    const p = await P.createProduct(adm, { code: 'E1', name: 'Бараа', price: 1000, costPrice: 400 });
    await P.updateProduct(adm, p.id, { costPrice: 450 }, { reason: 'Өртөг шинэчлэв', version: p.version });
    expect(JSON.stringify(await P.getProduct(mk, p.id))).not.toMatch(/costPrice|450|400/);
    expect(JSON.stringify(await P.listProducts(mk, {}))).not.toMatch(/costPrice/);
    const h = JSON.stringify(await H.listProductHistory(mk, { productId: p.id }));
    expect(h).not.toMatch(/450|"400/);
    expect(JSON.stringify(await P.getProduct(adm, p.id))).toMatch(/"costPrice":450/);
  });
});

describe('хувилбар', () => {
  it('тэнхлэгээс хасвал устгахгүй — идэвхгүй; буцааж нэмбэл сэргэнэ; ID хэвээр', async () => {
    const a = await actor(['MARKETING']);
    let p = await P.createProduct(a, { code: 'V1', name: 'Пүүз', price: 1000, colors: ['Хар', 'Цагаан'] });
    const ids = p.variants.map((v) => v.id);
    p = (await P.updateProduct(a, p.id, { colors: ['Хар'] }, { reason: 'Цагаан дууссан', version: p.version })).product;
    expect(p.variants.find((v) => v.color === 'Цагаан')!.isActive).toBe(false);
    p = (await P.updateProduct(a, p.id, { colors: ['Хар', 'Цагаан'] }, { reason: 'Цагаан дахин ирсэн', version: p.version })).product;
    expect(p.variants.every((v) => v.isActive)).toBe(true);
    expect(p.variants.map((v) => v.id).sort()).toEqual(ids.sort());
  });
  it('өнгөгүй → өнгөтэй: үндсэн хувилбар идэвхгүй, шинэ хувилбарууд', async () => {
    const a = await actor(['MARKETING']);
    let p = await P.createProduct(a, { code: 'V2', name: 'Ороолт', price: 1000 });
    p = (await P.updateProduct(a, p.id, { colors: ['Саарал', 'Хар'] }, { reason: 'Өнгө нэмэв', version: p.version })).product;
    expect(p.variants.filter((v) => v.isActive).map((v) => v.code)).toEqual(['V2-САААРАЛ'.replace('САААРАЛ', 'СААРАЛ'), 'V2-ХАР']);
    expect(p.variants.find((v) => v.code === 'V2')!.isActive).toBe(false);
  });
  it('хувилбарт өөр үнэ; гараар идэвхгүй болгосныг тэнхлэг солиход хадгална', async () => {
    const a = await actor(['MARKETING']);
    let p = await P.createProduct(a, { code: 'V3', name: 'Пүүз', price: 1000, sizes: ['38', '45'] });
    const big = p.variants.find((v) => v.size === '45')!;
    const s38 = p.variants.find((v) => v.size === '38')!;
    p = (await P.updateProduct(a, p.id, { variants: [{ id: big.id, priceOverride: 1200 }, { id: s38.id, isActive: false }] }, { reason: 'Том размер үнэтэй', version: p.version })).product;
    expect(p.variants.find((v) => v.id === big.id)!.price).toBe(1200);
    p = (await P.updateProduct(a, p.id, { sizes: ['38', '45', '46'] }, { reason: '46 размер нэмэв', version: p.version })).product;
    expect(p.variants.find((v) => v.id === s38.id)!.isActive).toBe(false);
    expect(p.variants.find((v) => v.size === '46')!.isActive).toBe(true);
  });
  it('бүх хувилбарыг идэвхгүй болгож болохгүй', async () => {
    const a = await actor(['MARKETING']);
    const p = await P.createProduct(a, { code: 'V4', name: 'Бараа', price: 1000 });
    await err(P.updateProduct(a, p.id, { variants: [{ id: p.variants[0]!.id, isActive: false }] }, { reason: R, version: p.version }), 400);
  });
});

describe('төлөв (#25, #27)', () => {
  it('маркетинг солихгүй; ахлах маркетинг солино, тайлбартай; архив жагсаалтаас нуугдана', async () => {
    const mk = await actor(['MARKETING']);
    const ml = await actor(['MARKETING_LEAD']);
    const p = await P.createProduct(mk, { code: 'S1', name: 'Бараа', price: 1000 });
    await err(P.setProductStatus(mk, p.id, { status: 'ARCHIVED', reason: R, version: p.version }), 403);
    await err(P.setProductStatus(ml, p.id, { status: 'ARCHIVED', reason: '', version: p.version }), 400, 'reason_required');
    await P.setProductStatus(ml, p.id, { status: 'ARCHIVED', reason: 'Улирал дууссан', version: p.version });
    expect((await P.listProducts(mk, {})).total).toBe(0);
    expect((await P.listProducts(mk, { status: 'archived' })).total).toBe(1);
    expect(await P.searchVariants(await actor(['OPERATOR']), 'S1')).toHaveLength(0);
  });
});

describe('хайлт (Модуль 3-т)', () => {
  it('оператор хайна, үр дүнд өртөг байхгүй, хувилбарын үнэ зөв', async () => {
    const adm = await actor(['ADMIN']);
    const p = await P.createProduct(adm, { code: '0887', name: 'Цагаан пүүз', price: 195000, costPrice: 100000, sizes: ['38', '45'] });
    await P.updateProduct(adm, p.id, { variants: [{ id: p.variants[1]!.id, priceOverride: 205000 }] }, { reason: R, version: p.version });
    const op = await actor(['OPERATOR']);
    const r = await P.searchVariants(op, 'пүүз');
    expect(r.map((x) => [x.variantCode, x.price])).toEqual([['0887-38', 195000], ['0887-45', 205000]]);
    expect(JSON.stringify(r)).not.toMatch(/cost|100000/);
    await err(P.searchVariants(await actor(['DRIVER']), 'пүүз'), 403);
  });
});

describe('ангилал, улирал', () => {
  it('ахлах маркетинг удирдана, маркетинг удирдахгүй; олноор оноохдоо тайлбар', async () => {
    const ml = await actor(['MARKETING_LEAD']);
    const mk = await actor(['MARKETING']);
    await err(C.createCatalogItem(mk, 'categories', { name: 'Гутал' }), 403);
    const cat = await C.createCatalogItem(ml, 'categories', { name: 'Гутал', color: 'orange' });
    await err(C.createCatalogItem(ml, 'categories', { name: 'Гутал' }), 409);
    const a = await P.createProduct(mk, { code: 'K1', name: 'Пүүз 1', price: 1000 });
    const b = await P.createProduct(mk, { code: 'K2', name: 'Пүүз 2', price: 1000 });
    await err(P.bulkAssignCategory(mk, { productIds: [a.id, b.id], categoryId: cat.id, reason: '' }), 400, 'reason_required');
    const r = await P.bulkAssignCategory(mk, { productIds: [a.id, b.id], categoryId: cat.id, reason: 'Гутлууд ангилав' });
    expect(r.changed).toBe(2);
    expect((await P.listProducts(mk, { categoryId: cat.id })).total).toBe(2);
    const list = await C.listCatalog(mk, 'categories');
    expect(list[0]).toMatchObject({ name: 'Гутал', productCount: 2 });
  });
});

describe('зураг', () => {
  it('3 хэмжээ үүснэ, анхны нь үндсэн, тайлбар заавал', async () => {
    const a = await actor(['MARKETING']);
    const p = await P.createProduct(a, { code: 'I1', name: 'Бараа', price: 1000, colors: ['Хар'] });
    await err(I.addProductImage(a, p.id, await png(), { reason: '' }), 400, 'reason_required');
    const img = await I.addProductImage(a, p.id, await png(), { reason: 'Зураг нэмэв', color: 'Хар' });
    expect(img.isMain).toBe(true);
    for (const s of ['sm', 'md', 'lg']) expect(existsSync(path.join(UPLOAD_DIR, img[s as 'sm'].replace('/media/', '')))).toBe(true);
    const meta = await sharp(path.join(UPLOAD_DIR, img.sm.replace('/media/', ''))).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBe(320);
  });
  it('буруу файл, байхгүй өнгө, 9 дэх зураг татгалзана', async () => {
    const a = await actor(['MARKETING']);
    const p = await P.createProduct(a, { code: 'I2', name: 'Бараа', price: 1000 });
    await err(I.addProductImage(a, p.id, Buffer.from('энэ зураг биш'), { reason: 'Зураг нэмэв' }), 400, 'image_invalid');
    const gif = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } }).gif().toBuffer();
    await err(I.addProductImage(a, p.id, gif, { reason: 'Зураг нэмэв' }), 400, 'image_type');
    await err(I.addProductImage(a, p.id, await png(), { reason: 'Зураг нэмэв', color: 'Ягаан' }), 400);
    const small = await png(50, 50);
    for (let i = 0; i < 8; i++) await I.addProductImage(a, p.id, small, { reason: 'Зураг нэмэв' });
    await err(I.addProductImage(a, p.id, small, { reason: 'Зураг нэмэв' }), 400, 'too_many_images');
  });
  it('үндсэн зураг хасвал дараагийнх нь үндсэн болно; давтан хасахад 404/409', async () => {
    const a = await actor(['MARKETING']);
    const p = await P.createProduct(a, { code: 'I3', name: 'Бараа', price: 1000 });
    const one = await I.addProductImage(a, p.id, await png(60, 60), { reason: 'Зураг нэмэв' });
    const two = await I.addProductImage(a, p.id, await png(60, 60), { reason: 'Зураг нэмэв' });
    await I.deleteProductImage(a, one.id, 'Чанар муу зураг');
    const full = await P.getProduct(a, p.id);
    expect(full.images).toHaveLength(1);
    expect(full.images[0]).toMatchObject({ id: two.id, isMain: true });
    await err(I.deleteProductImage(a, one.id, 'Чанар муу зураг'), 404);
  });
});

describe('засварын түүх хуудас (#29)', () => {
  it('чухал шүүлт, шалгах: өөрийнхийгөө шалгахгүй, давтан дарахад нэг бичлэг, маркетинг шалгахгүй', async () => {
    const mk = await actor(['MARKETING']);
    const ml = await actor(['MARKETING_LEAD']);
    const p = await P.createProduct(mk, { code: 'H1', name: 'Бараа', price: 1000 });
    const r1 = await P.updateProduct(mk, p.id, { name: 'Нэр засав' }, { reason: 'Үсгийн алдаа', version: p.version });
    await P.updateProduct(mk, p.id, { price: 900 }, { reason: 'Хямдрал', version: r1.product.version });
    const all = await H.listProductHistory(ml, {});
    expect(all.items).toHaveLength(3);
    const imp = await H.listProductHistory(ml, { important: true });
    expect(imp.items).toHaveLength(1);
    expect(await H.unreviewedCount(ml, { fresh: true })).toBe(2);
    const id = imp.items[0]!.id;
    await err(H.reviewProductEdit(mk, id), 403);
    await H.reviewProductEdit(ml, id);
    await H.reviewProductEdit(ml, id);
    expect(await db.auditReview.count()).toBe(1);
    expect(await H.unreviewedCount(ml, { fresh: true })).toBe(1);
    const un = await H.listProductHistory(ml, { unreviewed: true });
    expect(un.items.map((i) => i.id)).not.toContain(id);
    const own = await P.updateProduct(ml, p.id, { name: 'Ахлагч засав' }, { reason: 'Ахлагчийн засвар', version: (await P.getProduct(ml, p.id)).version });
    expect(own.changed).toBe(true);
    const mine = (await H.listProductHistory(ml, { actorId: ml.id })).items[0]!;
    await err(H.reviewProductEdit(ml, mine.id), 403);
  });
  it('харах эрх: агуулах, торгууль харна; оператор харахгүй', async () => {
    await H.listProductHistory(await actor(['WAREHOUSE']), {});
    await H.listProductHistory(await actor(['PENALTY_OFFICER']), {});
    await err(H.listProductHistory(await actor(['OPERATOR']), {}), 403);
  });
});

describe('эвдэрхий зураг', () => {
  it('толгой нь зөв, дотор нь эвдэрсэн PNG → 400 image_invalid (500 биш)', async () => {
    const a = await actor(['MARKETING']);
    const p = await P.createProduct(a, { code: 'BROKEN', name: 'Бараа', price: 1000 });
    const good = await png(300, 300);
    const corrupt = Buffer.concat([good.subarray(0, 60), Buffer.alloc(200, 7)]);
    await err(I.addProductImage(a, p.id, corrupt, { reason: 'Зураг нэмэв' }), 400, 'image_invalid');
  });
});
