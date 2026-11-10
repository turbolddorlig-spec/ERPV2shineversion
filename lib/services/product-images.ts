import type { Prisma } from '@prisma/client';
import { db } from '../db';
import { writeAudit } from '../audit';
import { badRequest, conflict, forbidden, notFound } from '../errors';
import { canEdit } from '../permissions';
import { mediaUrl, saveProductImage } from '../storage';
import { reasonProblem } from '../catalog/variants';
import type { UserActor } from './users';

export const MAX_IMAGES_PER_PRODUCT = 8;

function assertEdit(actor: UserActor) {
  if (!canEdit(actor.roles, 'products')) throw forbidden('Танд бараа засах эрх байхгүй');
}

function cleanReason(reason: unknown): string {
  const problem = reasonProblem(reason);
  if (problem) throw badRequest(problem, 'reason_required');
  return String(reason).trim().slice(0, 500);
}

function cleanColor(color: unknown, colors: string[]): string {
  const c = String(color ?? '').trim();
  if (c && !colors.includes(c)) throw badRequest('Ийм өнгө энэ бараанд байхгүй');
  return c;
}

/** Зураг нэмэх — зураг нэмэх нь ч засвар тул тайлбар заавал (шийдвэр #29) */
export async function addProductImage(actor: UserActor, productId: number, file: Buffer, opts: { color?: unknown; reason?: unknown }) {
  assertEdit(actor);
  const reason = cleanReason(opts.reason);
  const product = await db.product.findUnique({ where: { id: productId }, select: { id: true, code: true, name: true, colors: true } });
  if (!product) throw notFound('Бараа олдсонгүй');
  const color = cleanColor(opts.color, product.colors);
  const count = await db.productImage.count({ where: { productId } });
  if (count >= MAX_IMAGES_PER_PRODUCT) throw badRequest(`Нэг бараанд ${MAX_IMAGES_PER_PRODUCT} хүртэл зураг`, 'too_many_images');

  const saved = await saveProductImage(productId, file);
  return db.$transaction(async (tx) => {
    // Зэрэг upload хийхэд хязгаарыг дахин шалгана
    const n = await tx.productImage.count({ where: { productId } });
    if (n >= MAX_IMAGES_PER_PRODUCT) throw badRequest(`Нэг бараанд ${MAX_IMAGES_PER_PRODUCT} хүртэл зураг`, 'too_many_images');
    const img = await tx.productImage.create({
      data: { productId, color, isMain: n === 0, sortOrder: n, ...saved },
    });
    await tx.product.update({ where: { id: productId }, data: { version: { increment: 1 }, updatedById: actor.id } });
    await writeAudit(actor, 'product.image_added', 'Product', String(productId), {
      reason, code: product.code, name: product.name, changes: { image: { from: null, to: color ? `нэмсэн (${color})` : 'нэмсэн' } }, imageId: img.id,
    }, tx, ['image']);
    return { id: img.id, color: img.color, isMain: img.isMain, sm: mediaUrl(img.fileKey, 'sm'), md: mediaUrl(img.fileKey, 'md'), lg: mediaUrl(img.fileKey, 'lg') };
  });
}

export async function updateProductImage(actor: UserActor, imageId: string, input: { color?: unknown; isMain?: unknown; move?: unknown; reason?: unknown }) {
  assertEdit(actor);
  const reason = cleanReason(input.reason);
  if (!/^[0-9a-f-]{36}$/i.test(imageId)) throw notFound('Зураг олдсонгүй');
  const img = await db.productImage.findUnique({ where: { id: imageId }, include: { product: { select: { id: true, code: true, name: true, colors: true } } } });
  if (!img) throw notFound('Зураг олдсонгүй');
  const changes: Record<string, { from: unknown; to: unknown }> = {};

  await db.$transaction(async (tx) => {
    if (input.color !== undefined) {
      const c = cleanColor(input.color, img.product.colors);
      if (c !== img.color) { await tx.productImage.update({ where: { id: imageId }, data: { color: c } }); changes.imageColor = { from: img.color || 'ерөнхий', to: c || 'ерөнхий' }; }
    }
    if (input.isMain === true && !img.isMain) {
      await tx.productImage.updateMany({ where: { productId: img.productId }, data: { isMain: false } });
      await tx.productImage.update({ where: { id: imageId }, data: { isMain: true } });
      changes.mainImage = { from: null, to: 'үндсэн зураг сольсон' };
    }
    if (input.move === 'up' || input.move === 'down') {
      const all = await tx.productImage.findMany({ where: { productId: img.productId }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
      const i = all.findIndex((x) => x.id === imageId);
      const j = input.move === 'up' ? i - 1 : i + 1;
      if (i >= 0 && j >= 0 && j < all.length) {
        [all[i], all[j]] = [all[j]!, all[i]!];
        for (let k = 0; k < all.length; k++) await tx.productImage.update({ where: { id: all[k]!.id }, data: { sortOrder: k } });
        changes.imageOrder = { from: null, to: 'дараалал сольсон' };
      }
    }
    if (Object.keys(changes).length) {
      await tx.product.update({ where: { id: img.productId }, data: { version: { increment: 1 }, updatedById: actor.id } });
      await writeAudit(actor, 'product.image_updated', 'Product', String(img.productId), { reason, code: img.product.code, name: img.product.name, changes, imageId } as unknown as Prisma.InputJsonValue, tx, ['image']);
    }
  });
  return { ok: true, changed: Object.keys(changes).length > 0 };
}

/** Зураг хасах. Файл дискэнд үлдэнэ (түүх, backup-д), зөвхөн бараанаас салгана. */
export async function deleteProductImage(actor: UserActor, imageId: string, reasonInput: unknown) {
  assertEdit(actor);
  const reason = cleanReason(reasonInput);
  if (!/^[0-9a-f-]{36}$/i.test(imageId)) throw notFound('Зураг олдсонгүй');
  const img = await db.productImage.findUnique({ where: { id: imageId }, include: { product: { select: { code: true, name: true } } } });
  if (!img) throw notFound('Зураг олдсонгүй');
  await db.$transaction(async (tx) => {
    const del = await tx.productImage.deleteMany({ where: { id: imageId } });
    if (del.count === 0) throw conflict('Зураг аль хэдийн хасагдсан байна');
    if (img.isMain) {
      const next = await tx.productImage.findFirst({ where: { productId: img.productId }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
      if (next) await tx.productImage.update({ where: { id: next.id }, data: { isMain: true } });
    }
    await tx.product.update({ where: { id: img.productId }, data: { version: { increment: 1 }, updatedById: actor.id } });
    await writeAudit(actor, 'product.image_removed', 'Product', String(img.productId), {
      reason, code: img.product.code, name: img.product.name, changes: { image: { from: img.color ? `зураг (${img.color})` : 'зураг', to: 'хассан' } }, imageId, fileKey: img.fileKey,
    }, tx, ['image']);
  });
  return { ok: true };
}
