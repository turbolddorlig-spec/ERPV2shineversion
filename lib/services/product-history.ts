import { Prisma } from '@prisma/client';
import { db } from '../db';
import { badRequest, forbidden, notFound } from '../errors';
import { canReviewProductEdits, canSeeCost, canView } from '../permissions';
import { writeAudit } from '../audit';
import type { UserActor } from './users';

/**
 * "Барааны засварын түүх" (шийдвэр #29): бүх засвар нэг дор, хэн/хэзээ/юу/тайлбар.
 * Үнэ, код, төлөв, өртгийн өөрчлөлтийг "чухал" гэж тодруулна.
 * Өртгийн утгыг эрхгүй хүнд нууна.
 */
export const HISTORY_PAGE_SIZE = 50;
/** Шалгах шаардлагагүй: шинэ бараа, өртөг (зөвхөн СА/А, #32) */
export const NOT_REVIEWABLE = ['product.created', 'product.cost'];
export const IMPORTANT_TAGS = ['price', 'code', 'status', 'cost'];

export const PRODUCT_ACTION_LABEL: Record<string, string> = {
  'product.created': 'Бараа үүсгэсэн',
  'product.updated': 'Засвар',
  'product.cost': 'Өртөг өөрчилсөн',
  'product.status': 'Төлөв сольсон',
  'product.image_added': 'Зураг нэмсэн',
  'product.image_updated': 'Зураг өөрчилсөн',
  'product.image_removed': 'Зураг хассан',
};

export interface HistoryParams {
  productId?: number;
  actorId?: string;
  from?: string;
  to?: string;
  important?: boolean;
  unreviewed?: boolean;
  page?: number;
}

function redact(details: Prisma.JsonValue, showCost: boolean): Prisma.JsonValue {
  if (showCost || !details || typeof details !== 'object' || Array.isArray(details)) return details;
  const d = { ...(details as Record<string, Prisma.JsonValue>) };
  delete d.costPrice;
  const ch = d.changes;
  if (ch && typeof ch === 'object' && !Array.isArray(ch) && 'costPrice' in ch) {
    d.changes = { ...(ch as Record<string, Prisma.JsonValue>), costPrice: { from: '•••', to: '•••' } };
  }
  return d;
}

/** Улаанбаатарын өдрийн эхлэл (UTC+8) */
function ubDayStart(ymd: string, addDays = 0): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) throw badRequest('Огноо буруу');
  const d = new Date(`${ymd}T00:00:00+08:00`);
  d.setUTCDate(d.getUTCDate() + addDays);
  return d;
}

export async function listProductHistory(actor: UserActor, params: HistoryParams) {
  if (!canView(actor.roles, 'product-history') && !(params.productId && canView(actor.roles, 'products'))) throw forbidden();
  const and: Prisma.AuditLogWhereInput[] = [{ entityType: 'Product' }];
  if (params.productId) and.push({ entityId: String(params.productId) });
  if (params.actorId) {
    if (!/^[0-9a-f-]{36}$/i.test(params.actorId)) throw badRequest('Хэрэглэгч буруу');
    and.push({ actorId: params.actorId });
  }
  if (params.from) and.push({ at: { gte: ubDayStart(params.from) } });
  if (params.to) and.push({ at: { lt: ubDayStart(params.to, 1) } });
  if (params.important) and.push({ tags: { hasSome: IMPORTANT_TAGS } });
  if (params.unreviewed) {
    // Шалгаагүй: AuditReview-д бичлэггүй, бараа үүсгэснээс бусад засвар
    and.push({ action: { notIn: NOT_REVIEWABLE } });
    and.push({ id: { notIn: (await db.auditReview.findMany({ select: { auditLogId: true } })).map((r) => r.auditLogId) } });
  }
  const where: Prisma.AuditLogWhereInput = { AND: and };
  const page = Math.max(1, Math.min(10000, Math.floor(params.page ?? 1)));
  const [total, rows] = await Promise.all([
    db.auditLog.count({ where }),
    db.auditLog.findMany({ where, orderBy: { id: 'desc' }, skip: (page - 1) * HISTORY_PAGE_SIZE, take: HISTORY_PAGE_SIZE }),
  ]);
  const reviews = await db.auditReview.findMany({ where: { auditLogId: { in: rows.map((r) => r.id) } } });
  const byId = new Map(reviews.map((r) => [r.auditLogId.toString(), r]));
  const showCost = canSeeCost(actor.roles);
  return {
    total, page, pageSize: HISTORY_PAGE_SIZE,
    canReview: canReviewProductEdits(actor.roles),
    items: rows.map((r) => {
      const rev = byId.get(r.id.toString());
      return {
        id: r.id.toString(), at: r.at, actorId: r.actorId, actorName: r.actorName, action: r.action,
        actionLabel: PRODUCT_ACTION_LABEL[r.action] ?? r.action, productId: r.entityId ? Number(r.entityId) : null,
        tags: r.tags, important: r.tags.some((t) => IMPORTANT_TAGS.includes(t)),
        details: redact(r.details, showCost),
        review: rev ? { by: rev.reviewedByName, at: rev.reviewedAt } : null,
        reviewable: !NOT_REVIEWABLE.includes(r.action),
      };
    }),
  };
}

/**
 * Шалгаагүй засварын тоо — цэсний тэмдэгт (зөвхөн шалгах эрхтэй хүнд).
 * Хуудас бүр дээр дахин тоолохгүйн тулд 30 секунд санана (тэмдэгт 30 сек хоцорч болно — шалгах хуудас өөрөө үргэлж шинэ тоог харуулна).
 */
let badgeCache: { n: number; at: number } | null = null;
export async function unreviewedCount(actor: UserActor, opts: { fresh?: boolean } = {}): Promise<number> {
  if (!canReviewProductEdits(actor.roles)) return 0;
  if (!opts.fresh && badgeCache && Date.now() - badgeCache.at < 30_000) return badgeCache.n;
  const rows = await db.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM "AuditLog" a
    WHERE a."entityType" = 'Product' AND a.action NOT IN ('product.created', 'product.cost')
      AND NOT EXISTS (SELECT 1 FROM "AuditReview" r WHERE r."auditLogId" = a.id)`;
  const n = Number(rows[0]?.n ?? 0);
  badgeCache = { n, at: Date.now() };
  return n;
}

/**
 * "Шалгасан" тэмдэглэх. Давтан дарахад нэг л бичлэг.
 * Өөрийн засварыг өөрөө шалгахгүй — зөвхөн Супер админ өөрийнхөө засварыг шалгаж болно (эзний шийдвэр).
 */
export async function reviewProductEdit(actor: UserActor, auditId: string) {
  if (!canReviewProductEdits(actor.roles)) throw forbidden('Засварыг Супер админ, Админ, Ахлах маркетинг шалгана');
  if (!/^\d+$/.test(auditId)) throw notFound();
  const row = await db.auditLog.findUnique({ where: { id: BigInt(auditId) } });
  if (!row || row.entityType !== 'Product') throw notFound('Засвар олдсонгүй');
  if (NOT_REVIEWABLE.includes(row.action)) throw badRequest('Энэ бичлэгийг шалгах шаардлагагүй');
  if (row.actorId === actor.id && !actor.roles.includes('SUPER_ADMIN')) throw forbidden('Өөрийн засварыг өөрөө шалгаж болохгүй');
  await db.auditReview.createMany({
    data: [{ auditLogId: row.id, reviewedById: actor.id, reviewedByName: actor.name }],
    skipDuplicates: true,
  });
  badgeCache = null;
  const r = await db.auditReview.findUniqueOrThrow({ where: { auditLogId: row.id } });
  return { by: r.reviewedByName, at: r.reviewedAt };
}

/** Шалгаагүй бүх засварыг нэг дор "Шалгасан" болгох — зөвхөн Супер админ. Үйлдэл өөрөө түүхэнд бичигдэнэ. */
export async function reviewAllProductEdits(actor: UserActor) {
  if (!actor.roles.includes('SUPER_ADMIN')) throw forbidden('Бүгдийг шалгасан болгохыг зөвхөн Супер админ хийнэ');
  const count = await db.$transaction(async (tx) => {
    const n = await tx.$executeRaw`
      INSERT INTO "AuditReview" ("auditLogId", "reviewedById", "reviewedByName", "reviewedAt")
      SELECT a.id, ${actor.id}::uuid, ${actor.name}, now() FROM "AuditLog" a
      WHERE a."entityType" = 'Product' AND a.action NOT IN ('product.created', 'product.cost')
        AND NOT EXISTS (SELECT 1 FROM "AuditReview" r WHERE r."auditLogId" = a.id)
      ON CONFLICT ("auditLogId") DO NOTHING`;
    if (n > 0) await writeAudit(actor, 'product.review_all', 'ProductReview', null, { count: n }, tx);
    return n;
  });
  badgeCache = null;
  return { count };
}
