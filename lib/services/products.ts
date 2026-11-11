import { Prisma, type ProductStatus } from '@prisma/client';
import { db } from '../db';
import { writeAudit } from '../audit';
import { badRequest, conflict, forbidden, notFound } from '../errors';
import { canChangeProductCode, canChangeProductStatus, canEdit, canSearchProducts, canSeeCost, canView } from '../permissions';
import { productStockTotals } from './stock/views';
import { availableFor } from './orders/core';
import { mediaUrl } from '../storage';
import {
  cleanAxis, cleanProductCode, comboKey, combos, reasonProblem, suggestNextCode, variantCode, variantLabel, type Combo,
} from '../catalog/variants';
import type { UserActor } from './users';

export const PRODUCT_PAGE_SIZE = 50;

export const STATUS_LABEL: Record<ProductStatus, string> = {
  ACTIVE: 'Идэвхтэй',
  DISCONTINUED: 'Зогсоосон',
  ARCHIVED: 'Архив',
};

// ───────────────────────── туслах ─────────────────────────

function assertView(actor: UserActor) {
  if (!canView(actor.roles, 'products')) throw forbidden();
}
function assertEdit(actor: UserActor) {
  if (!canEdit(actor.roles, 'products')) throw forbidden('Танд бараа засах эрх байхгүй');
}

function cleanName(v: unknown): string {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (s.length < 2) throw badRequest('Барааны нэр дор хаяж 2 тэмдэгт байх ёстой');
  if (s.length > 150) throw badRequest('Барааны нэр хэт урт байна');
  return s;
}

function cleanDescription(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (s.length > 3000) throw badRequest('Тайлбар хэт урт байна');
  return s || null;
}

function cleanMoney(v: unknown, label: string, opts: { allowZero?: boolean; nullable?: boolean } = {}): number | null {
  if ((v === null || v === undefined || v === '') && opts.nullable) return null;
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[\s,₮]/g, ''));
  if (!Number.isInteger(n)) throw badRequest(`${label} бүхэл тоо (төгрөг) байх ёстой`);
  if (n < 0 || (!opts.allowZero && n === 0)) throw badRequest(`${label} 0-ээс их байх ёстой`);
  if (n > 1_000_000_000) throw badRequest(`${label} хэт их байна`);
  return n;
}

function cleanRefId(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw badRequest('Буруу сонголт');
  return n;
}

function cleanCode(v: unknown): string {
  const c = cleanProductCode(v);
  if (!c) throw badRequest('Код 1–40 тэмдэгт, хоосон зайгүй байх ёстой');
  return c;
}

function uniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

async function assertRefsExist(categoryId: number | null, seasonId: number | null) {
  if (categoryId !== null && !(await db.category.findUnique({ where: { id: categoryId } }))) throw badRequest('Ангилал олдсонгүй');
  if (seasonId !== null && !(await db.season.findUnique({ where: { id: seasonId } }))) throw badRequest('Улирал олдсонгүй');
}

const FULL_INCLUDE = {
  category: { select: { id: true, name: true, color: true } },
  season: { select: { id: true, name: true } },
  variants: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
  images: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
} satisfies Prisma.ProductInclude;

type FullProduct = Prisma.ProductGetPayload<{ include: typeof FULL_INCLUDE }>;

/** API хариу: өртгийг зөвхөн эрхтэй хүнд (шийдвэр #26) */
export function serializeProduct(p: FullProduct, roles: UserActor['roles']) {
  const showCost = canSeeCost(roles);
  return {
    id: p.id, code: p.code, name: p.name, description: p.description,
    category: p.category, season: p.season,
    price: p.price, ...(showCost ? { costPrice: p.costPrice } : {}), deliveryIncluded: p.deliveryIncluded,
    status: p.status, statusLabel: STATUS_LABEL[p.status], statusNote: p.statusNote,
    colors: p.colors, sizes: p.sizes, version: p.version,
    createdAt: p.createdAt, updatedAt: p.updatedAt,
    variants: p.variants.map((v) => ({
      id: v.id, code: v.code, color: v.color, size: v.size, label: variantLabel(v),
      priceOverride: v.priceOverride, price: v.priceOverride ?? p.price, isActive: v.isActive,
    })),
    images: p.images.map((i) => ({
      id: i.id, color: i.color, isMain: i.isMain, sortOrder: i.sortOrder, width: i.width, height: i.height,
      sm: mediaUrl(i.fileKey, 'sm'), md: mediaUrl(i.fileKey, 'md'), lg: mediaUrl(i.fileKey, 'lg'),
    })),
  };
}

async function loadFull(id: number): Promise<FullProduct> {
  if (!Number.isInteger(id) || id <= 0) throw notFound('Бараа олдсонгүй');
  const p = await db.product.findUnique({ where: { id }, include: FULL_INCLUDE });
  if (!p) throw notFound('Бараа олдсонгүй');
  return p;
}

// ───────────────────────── жагсаалт ─────────────────────────

export interface ListParams {
  q?: string;
  categoryId?: number;
  seasonId?: number;
  status?: 'live' | 'active' | 'discontinued' | 'archived' | 'all';
  page?: number;
}

export async function listProducts(actor: UserActor, params: ListParams) {
  assertView(actor);
  const and: Prisma.ProductWhereInput[] = [];
  const q = params.q?.trim();
  if (q) {
    and.push({ OR: [
      { code: { contains: q, mode: 'insensitive' } },
      { name: { contains: q, mode: 'insensitive' } },
      { variants: { some: { code: { contains: q, mode: 'insensitive' } } } },
    ] });
  }
  if (params.categoryId) and.push({ categoryId: params.categoryId });
  if (params.seasonId) and.push({ seasonId: params.seasonId });
  const st = params.status ?? 'live';
  if (st === 'live') and.push({ status: { in: ['ACTIVE', 'DISCONTINUED'] } });
  if (st === 'active') and.push({ status: 'ACTIVE' });
  if (st === 'discontinued') and.push({ status: 'DISCONTINUED' });
  if (st === 'archived') and.push({ status: 'ARCHIVED' });
  const where: Prisma.ProductWhereInput = and.length ? { AND: and } : {};

  const page = Math.max(1, Math.min(10000, Math.floor(params.page ?? 1)));
  const showCost = canSeeCost(actor.roles);
  const [total, rows] = await Promise.all([
    db.product.count({ where }),
    db.product.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * PRODUCT_PAGE_SIZE,
      take: PRODUCT_PAGE_SIZE,
      select: {
        id: true, code: true, name: true, price: true, costPrice: true, status: true, colors: true, sizes: true, updatedAt: true,
        category: { select: { id: true, name: true, color: true } },
        season: { select: { id: true, name: true } },
        images: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], select: { fileKey: true, color: true, isMain: true } },
        variants: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], select: { id: true, code: true, color: true, size: true, priceOverride: true, isActive: true } },
      },
    }),
  ]);
  // Үлдэгдэл (Модуль 2): агуулахуудын нийт ба захиалах боломжтой
  const stock = await productStockTotals(rows.map((r) => r.id));
  return {
    total, page, pageSize: PRODUCT_PAGE_SIZE,
    items: rows.map((r) => ({
      stock: { total: stock.get(r.id)?.total ?? 0, available: stock.get(r.id)?.available ?? 0, driver: stock.get(r.id)?.driver ?? 0 },
      id: r.id, code: r.code, name: r.name, price: r.price, ...(showCost ? { costPrice: r.costPrice } : {}),
      status: r.status, statusLabel: STATUS_LABEL[r.status], category: r.category, season: r.season,
      // Ганц өнгө/хэмжээтэй бол энгийн бараа: доор нь хувилбарын мөр гаргахгүй, өнгө/хэмжээг өөр дээр нь харуулна (#34)
      variantCount: r.variants.filter((v) => v.isActive).length, hasVariants: r.variants.length > 1,
      attrs: r.variants.length === 1 && r.colors.length + r.sizes.length > 0 ? variantLabel(r.variants[0]!) : null,
      thumb: (() => { const m = r.images.find((i) => i.isMain) ?? r.images[0]; return m ? mediaUrl(m.fileKey, 'sm') : null; })(),
      updatedAt: r.updatedAt,
      // Жагсаалтад бараа бүрийн доор догол мөрөөр харуулах хувилбарууд (#32)
      variants: r.variants.length > 1 ? r.variants.map((v) => {
        const img = v.color ? r.images.find((i) => i.color === v.color) : undefined;
        return {
          id: v.id, code: v.code, color: v.color, size: v.size, label: variantLabel(v), isActive: v.isActive,
          price: v.priceOverride ?? r.price, priceOverride: v.priceOverride !== null,
          stock: stock.get(r.id)?.byVariant.get(v.id) ?? { total: 0, available: 0, driver: 0 },
          thumb: img ? mediaUrl(img.fileKey, 'sm') : null,
        };
      }) : [],
    })),
  };
}

export async function getProduct(actor: UserActor, id: number) {
  assertView(actor);
  return serializeProduct(await loadFull(id), actor.roles);
}

// ───────────────────────── шинэ бараа ─────────────────────────

export interface ProductInput {
  code?: unknown; name?: unknown; description?: unknown; categoryId?: unknown; seasonId?: unknown;
  price?: unknown; costPrice?: unknown; colors?: unknown; sizes?: unknown; deliveryIncluded?: unknown;
}

export async function createProduct(actor: UserActor, input: ProductInput) {
  assertEdit(actor);
  const code = cleanCode(input.code);
  const name = cleanName(input.name);
  const description = cleanDescription(input.description);
  const categoryId = cleanRefId(input.categoryId);
  const seasonId = cleanRefId(input.seasonId);
  const price = cleanMoney(input.price, 'Үнэ')!;
  let costPrice: number | null = null;
  if (input.costPrice !== undefined && input.costPrice !== null && input.costPrice !== '') {
    // Анх бүртгэхэд барааг үүсгэх эрхтэй хүн бүр өртөг оруулж болно; дараа нь засах, харах нь зөвхөн СА/А (#32)
    costPrice = cleanMoney(input.costPrice, 'Өртөг', { allowZero: true });
  }
  const colors = cleanAxis(input.colors);
  const sizes = cleanAxis(input.sizes);
  await assertRefsExist(categoryId, seasonId);

  const list = combos(colors, sizes);
  try {
    const p = await db.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: {
          code, name, description, categoryId, seasonId, price, costPrice, colors, sizes, deliveryIncluded: input.deliveryIncluded !== false,
          createdById: actor.id, updatedById: actor.id,
          variants: { create: list.map((c, i) => ({ code: variantCode(code, c), color: c.color, size: c.size, sortOrder: i })) },
        },
        include: FULL_INCLUDE,
      });
      await writeAudit(actor, 'product.created', 'Product', String(created.id), {
        code, name, price, colors, sizes, variants: list.length,
        ...(costPrice !== null ? { costPrice } : {}),
      }, tx, ['created']);
      return created;
    });
    return serializeProduct(p, actor.roles);
  } catch (e) {
    if (uniqueViolation(e)) throw conflict(`"${code}" кодтой бараа (эсвэл хувилбар) аль хэдийн бүртгэлтэй байна`, 'code_taken');
    throw e;
  }
}

// ───────────────────────── засвар (тайлбартай, шийдвэр #29) ─────────────────────────

export interface UpdateInput extends ProductInput {
  /** [{id, priceOverride, isActive}] — хувилбар тус бүрийн тохиргоо */
  variants?: unknown;
}

type Change = { from: unknown; to: unknown };

export async function updateProduct(actor: UserActor, id: number, input: UpdateInput, opts: { reason: unknown; version: unknown }) {
  assertEdit(actor);
  const version = Number(opts.version);
  if (!Number.isInteger(version)) throw badRequest('Хувилбарын дугаар алга', 'version_required');

  const p = await loadFull(id);
  if (p.version !== version) throw conflict('Энэ барааг өөр хүн дөнгөж сая засчихсан байна. Хуудсаа дахин ачаалаад, өөрчлөлтөө дахин хийнэ үү.', 'stale');

  const changes: Record<string, Change> = {};
  const tags = new Set<string>();
  const data: Prisma.ProductUpdateInput = {};

  // Код (зөвхөн админ, #28)
  let newCode = p.code;
  if (input.code !== undefined) {
    const c = cleanCode(input.code);
    if (c !== p.code) {
      if (!canChangeProductCode(actor.roles)) throw forbidden('Барааны кодыг зөвхөн Супер админ, Админ солино');
      newCode = c; data.code = c; changes.code = { from: p.code, to: c }; tags.add('code');
    }
  }
  if (input.name !== undefined) {
    const v = cleanName(input.name);
    if (v !== p.name) { data.name = v; changes.name = { from: p.name, to: v }; tags.add('info'); }
  }
  if (input.description !== undefined) {
    const v = cleanDescription(input.description);
    if (v !== p.description) { data.description = v; changes.description = { from: p.description, to: v }; tags.add('info'); }
  }
  if (typeof input.deliveryIncluded === 'boolean' && input.deliveryIncluded !== p.deliveryIncluded) {
    data.deliveryIncluded = input.deliveryIncluded; changes.deliveryIncluded = { from: p.deliveryIncluded, to: input.deliveryIncluded }; tags.add('price');
  }
  let categoryId = p.categoryId;
  let seasonId = p.seasonId;
  if (input.categoryId !== undefined) {
    const v = cleanRefId(input.categoryId);
    if (v !== p.categoryId) { categoryId = v; data.category = v ? { connect: { id: v } } : { disconnect: true }; changes.category = { from: p.category?.name ?? null, to: v }; tags.add('category'); }
  }
  if (input.seasonId !== undefined) {
    const v = cleanRefId(input.seasonId);
    if (v !== p.seasonId) { seasonId = v; data.season = v ? { connect: { id: v } } : { disconnect: true }; changes.season = { from: p.season?.name ?? null, to: v }; tags.add('season'); }
  }
  await assertRefsExist(categoryId !== p.categoryId ? categoryId : null, seasonId !== p.seasonId ? seasonId : null);
  if (changes.category) changes.category.to = categoryId ? (await db.category.findUnique({ where: { id: categoryId } }))?.name : null;
  if (changes.season) changes.season.to = seasonId ? (await db.season.findUnique({ where: { id: seasonId } }))?.name : null;

  if (input.price !== undefined) {
    const v = cleanMoney(input.price, 'Үнэ')!;
    if (v !== p.price) { data.price = v; changes.price = { from: p.price, to: v }; tags.add('price'); }
  }
  if (input.costPrice !== undefined) {
    const v = cleanMoney(input.costPrice, 'Өртөг', { allowZero: true, nullable: true });
    if (v !== p.costPrice) {
      if (!canSeeCost(actor.roles)) throw forbidden('Өртөг засах эрхгүй');
      data.costPrice = v; changes.costPrice = { from: p.costPrice, to: v }; tags.add('cost');
    }
  }

  // Хувилбарын тэнхлэгүүд
  const colors = input.colors !== undefined ? cleanAxis(input.colors) : p.colors;
  const sizes = input.sizes !== undefined ? cleanAxis(input.sizes) : p.sizes;
  const axesChanged = colors.join('\u0001') !== p.colors.join('\u0001') || sizes.join('\u0001') !== p.sizes.join('\u0001');
  if (axesChanged) {
    data.colors = { set: colors }; data.sizes = { set: sizes };
    changes.colors = { from: p.colors, to: colors }; changes.sizes = { from: p.sizes, to: sizes }; tags.add('variant');
  }

  // Хувилбар тус бүрийн үнэ / идэвх
  const variantPatches = new Map<number, { priceOverride?: number | null; isActive?: boolean }>();
  if (input.variants !== undefined) {
    if (!Array.isArray(input.variants)) throw badRequest('Хувилбарын өгөгдөл буруу');
    for (const raw of input.variants as Record<string, unknown>[]) {
      const vid = Number(raw?.id);
      if (!p.variants.some((v) => v.id === vid)) throw badRequest('Хувилбар олдсонгүй');
      const patch: { priceOverride?: number | null; isActive?: boolean } = {};
      if ('priceOverride' in raw) patch.priceOverride = cleanMoney(raw.priceOverride, 'Хувилбарын үнэ', { nullable: true });
      if ('isActive' in raw) patch.isActive = Boolean(raw.isActive);
      variantPatches.set(vid, patch);
    }
  }

  // Шинэ хувилбарын төлөвлөгөө
  const wanted = new Map(combos(colors, sizes).map((c) => [comboKey(c), c] as const));
  type VPlan = { id?: number; combo: Combo; code: string; isActive: boolean; priceOverride: number | null; sortOrder: number };
  const plan: VPlan[] = [];
  const seen = new Set<string>();
  // Өмнө нь тэнхлэгт байсан хослолууд: гараар идэвхгүй болгосныг хадгалж, тэнхлэгээс хасагдаад буцаж нэмэгдсэнийг сэргээнэ
  const previousKeys = new Set(combos(p.colors, p.sizes).map(comboKey));
  let order = 0;
  for (const [key, c] of wanted) {
    const existing = p.variants.find((v) => comboKey(v) === key);
    const patch = existing ? variantPatches.get(existing.id) : undefined;
    plan.push({
      id: existing?.id, combo: c, code: variantCode(newCode, c), sortOrder: order++,
      isActive: patch?.isActive ?? (existing ? (previousKeys.has(key) ? existing.isActive : true) : true),
      priceOverride: patch && 'priceOverride' in patch ? patch.priceOverride ?? null : existing?.priceOverride ?? null,
    });
    seen.add(key);
  }
  for (const v of p.variants) {
    if (seen.has(comboKey(v))) continue;
    // Тэнхлэгээс хасагдсан хувилбар — устгахгүй, идэвхгүй болгоно (үлдэгдлийн түүх алдагдахгүй)
    plan.push({ id: v.id, combo: v, code: variantCode(newCode, v), sortOrder: order++, isActive: false, priceOverride: v.priceOverride });
  }
  if (!plan.some((v) => v.isActive)) throw badRequest('Дор хаяж нэг идэвхтэй хувилбар байх ёстой');

  const variantChanges: Record<string, Change> = {};
  for (const v of plan) {
    const old = v.id ? p.variants.find((x) => x.id === v.id) : undefined;
    const label = variantLabel(v.combo);
    if (!old) { variantChanges[label] = { from: null, to: 'нэмэгдсэн' }; continue; }
    if (old.isActive !== v.isActive) variantChanges[label] = { from: old.isActive ? 'идэвхтэй' : 'идэвхгүй', to: v.isActive ? 'идэвхтэй' : 'идэвхгүй' };
    if (old.priceOverride !== v.priceOverride) {
      variantChanges[`${label} үнэ`] = { from: old.priceOverride ?? p.price, to: v.priceOverride ?? (data.price as number | undefined) ?? p.price };
      tags.add('price');
    }
  }
  if (Object.keys(variantChanges).length) { changes.variants = { from: null, to: variantChanges }; tags.add('variant'); }

  if (Object.keys(changes).length === 0) return { product: serializeProduct(p, actor.roles), changed: false };
  // Тайлбар заавал (#29). Зөвхөн өртөг өөрчилсөн бол (зөвхөн СА/А хийнэ) тайлбаргүй хадгална (#32)
  const costOnly = Object.keys(changes).every((k) => k === 'costPrice');
  const problem = reasonProblem(opts.reason);
  if (problem && !costOnly) throw badRequest(problem, 'reason_required');
  const reason = problem ? null : String(opts.reason).trim().slice(0, 500);

  try {
    const updated = await db.$transaction(async (tx) => {
      // Зэрэг засварыг хамгаална: хувилбарын дугаар таарсан үед л бичнэ
      const ok = await tx.product.updateMany({ where: { id, version }, data: { version: { increment: 1 } } });
      if (ok.count === 0) throw conflict('Энэ барааг өөр хүн дөнгөж сая засчихсан байна. Хуудсаа дахин ачаална уу.', 'stale');
      await tx.product.update({ where: { id }, data: { ...data, updatedById: actor.id } });
      // Код солигдвол түр нэрээр давхцал үүсэхээс сэргийлнэ
      if (newCode !== p.code) {
        for (const v of plan.filter((x) => x.id)) await tx.productVariant.update({ where: { id: v.id! }, data: { code: `~tmp-${v.id}` } });
      }
      for (const v of plan) {
        if (v.id) {
          await tx.productVariant.update({ where: { id: v.id }, data: { code: v.code, isActive: v.isActive, priceOverride: v.priceOverride, sortOrder: v.sortOrder } });
        } else {
          await tx.productVariant.create({ data: { productId: id, code: v.code, color: v.combo.color, size: v.combo.size, isActive: v.isActive, priceOverride: v.priceOverride, sortOrder: v.sortOrder } });
        }
      }
      await writeAudit(actor, costOnly ? 'product.cost' : 'product.updated', 'Product', String(id), {
        reason, code: newCode, name: (data.name as string) ?? p.name, changes,
      } as unknown as Prisma.InputJsonValue, tx, [...tags]);
      return tx.product.findUniqueOrThrow({ where: { id }, include: FULL_INCLUDE });
    });
    return { product: serializeProduct(updated, actor.roles), changed: true };
  } catch (e) {
    if (uniqueViolation(e)) throw conflict('Энэ код (эсвэл хувилбарын код) өөр бараанд ашиглагдаж байна', 'code_taken');
    throw e;
  }
}

// ───────────────────────── төлөв ─────────────────────────

export async function setProductStatus(actor: UserActor, id: number, input: { status: unknown; reason: unknown; version: unknown }) {
  if (!canChangeProductStatus(actor.roles)) throw forbidden('Төлөвийг Супер админ, Админ, Ахлах маркетинг солино');
  const problem = reasonProblem(input.reason);
  if (problem) throw badRequest(problem, 'reason_required');
  const status = String(input.status ?? '') as ProductStatus;
  if (!['ACTIVE', 'DISCONTINUED', 'ARCHIVED'].includes(status)) throw badRequest('Төлөв буруу');
  const version = Number(input.version);
  const reason = String(input.reason).trim().slice(0, 500);
  const p = await loadFull(id);
  if (p.status === status) return serializeProduct(p, actor.roles);
  const updated = await db.$transaction(async (tx) => {
    const ok = await tx.product.updateMany({ where: { id, version }, data: { version: { increment: 1 }, status, statusNote: reason, updatedById: actor.id } });
    if (ok.count === 0) throw conflict('Энэ барааг өөр хүн дөнгөж сая засчихсан байна. Хуудсаа дахин ачаална уу.', 'stale');
    await writeAudit(actor, 'product.status', 'Product', String(id), {
      reason, code: p.code, name: p.name, changes: { status: { from: STATUS_LABEL[p.status], to: STATUS_LABEL[status] } },
    }, tx, ['status']);
    return tx.product.findUniqueOrThrow({ where: { id }, include: FULL_INCLUDE });
  });
  return serializeProduct(updated, actor.roles);
}

// ───────────────────────── олноор ангилал оноох ─────────────────────────

export async function bulkAssignCategory(actor: UserActor, input: { productIds: unknown; categoryId: unknown; reason: unknown }) {
  assertEdit(actor);
  const problem = reasonProblem(input.reason);
  if (problem) throw badRequest(problem, 'reason_required');
  const reason = String(input.reason).trim().slice(0, 500);
  if (!Array.isArray(input.productIds) || input.productIds.length === 0) throw badRequest('Бараа сонгоно уу');
  if (input.productIds.length > 500) throw badRequest('Нэг удаад 500 хүртэл бараа');
  const ids = Array.from(new Set(input.productIds.map(Number))).filter((n) => Number.isInteger(n) && n > 0);
  const categoryId = cleanRefId(input.categoryId);
  const cat = categoryId ? await db.category.findUnique({ where: { id: categoryId } }) : null;
  if (categoryId && !cat) throw badRequest('Ангилал олдсонгүй');
  const products = await db.product.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, name: true, categoryId: true, category: { select: { name: true } } } });
  const toChange = products.filter((p) => p.categoryId !== categoryId);
  await db.$transaction(async (tx) => {
    for (const p of toChange) {
      await tx.product.update({ where: { id: p.id }, data: { categoryId, version: { increment: 1 }, updatedById: actor.id } });
      await writeAudit(actor, 'product.updated', 'Product', String(p.id), {
        reason, code: p.code, name: p.name, bulk: true, changes: { category: { from: p.category?.name ?? null, to: cat?.name ?? null } },
      }, tx, ['category']);
    }
  }, { timeout: 30000 });
  return { changed: toChange.length };
}

// ───────────────────────── дараагийн код, хайлт, экспорт ─────────────────────────

export async function nextProductCode(actor: UserActor): Promise<string> {
  assertEdit(actor);
  const rows = await db.$queryRaw<{ code: string }[]>`
    SELECT code FROM "Product" WHERE code ~ '^[0-9]+$' ORDER BY length(code) DESC, code DESC LIMIT 1`;
  let candidate = suggestNextCode(rows.map((r) => r.code));
  for (let i = 0; i < 50; i++) {
    const taken = await db.product.findUnique({ where: { code: candidate }, select: { id: true } });
    if (!taken) return candidate;
    candidate = suggestNextCode([candidate]);
  }
  return candidate;
}

/**
 * Захиалга авахад бараа хайх (Модуль 3 ашиглана). Архивласан бараа, идэвхгүй хувилбар гарахгүй.
 * Өртөг хэзээ ч буцахгүй.
 */
export async function searchVariants(actor: UserActor, qInput: string, limit = 20) {
  if (!canSearchProducts(actor.roles)) throw forbidden();
  const q = qInput.trim().slice(0, 60);
  if (q.length < 1) return [];
  const take = Math.min(50, Math.max(1, limit));
  const like = `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
  const prefix = `${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
  // 1-р алхам: тохирох барааны ID-г индексээр олно (нэр/код — trigram, хувилбарын код — trigram).
  // Кодоор эхэлсэн нь эхэнд, дараа нь идэвхтэй нь.
  const hits = await db.$queryRaw<{ id: number }[]>`
    WITH h AS (
      SELECT p.id FROM "Product" p
       WHERE p.status IN ('ACTIVE','DISCONTINUED') AND (p.name ILIKE ${like} OR p.code ILIKE ${like})
      UNION
      SELECT v."productId" FROM "ProductVariant" v
       WHERE v."isActive" AND v.code ILIKE ${like}
    )
    SELECT p.id FROM h JOIN "Product" p ON p.id = h.id
     WHERE p.status IN ('ACTIVE','DISCONTINUED')
     ORDER BY (p.code ILIKE ${prefix}) DESC, p.status ASC, p.id ASC
     LIMIT ${take}`;
  if (!hits.length) return [];
  const order = new Map(hits.map((h, i) => [h.id, i]));
  // 2-р алхам: зөвхөн эдгээр барааны идэвхтэй хувилбарууд
  const rows = (await db.productVariant.findMany({
    where: { isActive: true, productId: { in: hits.map((h) => h.id) } },
    orderBy: [{ productId: 'asc' }, { sortOrder: 'asc' }],
    select: {
      id: true, code: true, color: true, size: true, priceOverride: true,
      product: {
        select: {
          id: true, code: true, name: true, price: true, status: true, description: true, deliveryIncluded: true,
          images: { orderBy: [{ isMain: 'desc' }, { sortOrder: 'asc' }], select: { fileKey: true, color: true } },
        },
      },
    },
  })).sort((a, b) => order.get(a.product.id)! - order.get(b.product.id)!).slice(0, take);
  // Захиалах боломжтой тоо (агуулахуудын нийт − нөөцлөлт) — оператор захиалга авахад харна (Модуль 3)
  const av = await availableFor(db, rows.map((r) => r.id));
  return rows.map((v) => {
    const img = v.product.images.find((i) => v.color && i.color === v.color) ?? v.product.images[0];
    return {
      variantId: v.id, variantCode: v.code, productId: v.product.id, productCode: v.product.code, name: v.product.name,
      color: v.color, size: v.size, label: variantLabel(v), price: v.priceOverride ?? v.product.price,
      // Захиалгад харагдах нэг мөр: «Жигнүүрийн цаас · Улаан · 38см» (#34)
      fullName: v.color || v.size ? `${v.product.name} · ${variantLabel(v)}` : v.product.name,
      status: v.product.status, discontinued: v.product.status === 'DISCONTINUED',
      thumb: img ? mediaUrl(img.fileKey, 'sm') : null, image: img ? mediaUrl(img.fileKey, 'lg') : null,
      description: v.product.description, deliveryIncluded: v.product.deliveryIncluded, available: av.get(v.id) ?? 0,
    };
  });
}

export async function exportRows(actor: UserActor) {
  assertView(actor);
  const showCost = canSeeCost(actor.roles);
  const rows = await db.product.findMany({
    orderBy: { code: 'asc' },
    select: {
      code: true, name: true, price: true, costPrice: true, status: true,
      category: { select: { name: true } }, season: { select: { name: true } },
      variants: { where: { isActive: true }, orderBy: { sortOrder: 'asc' }, select: { code: true, color: true, size: true, priceOverride: true } },
    },
  });
  return { showCost, rows };
}
