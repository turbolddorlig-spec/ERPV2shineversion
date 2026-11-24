import type { Role } from '@prisma/client';
import { db } from '../db';
import { badRequest, conflict, forbidden, notFound } from '../errors';
import { writeAudit } from '../audit';
import { canEdit } from '../permissions';
import type { UserActor } from './users';

/**
 * #215 (эзэн): Нийлүүлэгчид мэдэгдэл — Супер админ / Админ нэг дэлгүүрт эсвэл БҮХ нийлүүлэгчид бичнэ.
 * Нийлүүлэгчид бүх хуудасны дээд талд улаан мэдэгдэл (+ хонх) — бичсэн хүн «Устгах» хүртэл харагдана.
 * Нийлүүлэгч «Уншсан» дарна (харагдсаар), бичсэн хүн хэн хэзээ уншсаныг харна.
 */
const assertAdmin = (a: UserActor) => { if (!canEdit(a.roles, 'supplier')) throw forbidden('Нийлүүлэгчид мэдэгдлийг Супер админ, Админ бичнэ'); };

export async function listNotices(actor: UserActor) {
  assertAdmin(actor);
  const [items, shops] = await Promise.all([
    db.supplierNotice.findMany({ where: { deletedAt: null }, orderBy: { id: 'desc' }, take: 100, include: { reads: true } }),
    db.supplierShop.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
  ]);
  const sm = new Map(shops.map((s) => [s.id, s.name]));
  return {
    shops,
    items: items.map((n) => ({
      id: n.id, shopId: n.shopId, shopName: n.shopId ? sm.get(n.shopId) ?? `#${n.shopId}` : null, text: n.text, createdByName: n.createdByName, createdAt: n.createdAt,
      reads: n.reads.map((r) => ({ shopId: r.shopId, shopName: sm.get(r.shopId) ?? `#${r.shopId}`, readAt: r.readAt, readBy: r.readBy })),
      readCount: n.reads.length, target: n.shopId ? 1 : shops.length,
    })),
  };
}

export async function createNotice(actor: UserActor, input: { shopId?: unknown; text?: unknown }) {
  assertAdmin(actor);
  const text = String(input.text ?? '').trim().slice(0, 1000);
  if (text.length < 3) throw badRequest('Мэдэгдлийн текстээ бичнэ үү');
  const all = input.shopId === null || input.shopId === undefined || input.shopId === '' || input.shopId === 'all';
  const shopId = all ? null : Number(input.shopId);
  if (shopId !== null) {
    if (!Number.isInteger(shopId) || shopId <= 0) throw badRequest('Нийлүүлэгчээ сонгоно уу');
    const s = await db.supplierShop.findUnique({ where: { id: shopId }, select: { isActive: true } });
    if (!s) throw notFound('Нийлүүлэгч олдсонгүй');
    if (!s.isActive) throw conflict('Идэвхгүй нийлүүлэгч', 'inactive');
  }
  return db.$transaction(async (tx) => {
    const n = await tx.supplierNotice.create({ data: { shopId, text, createdByName: actor.name } });
    await writeAudit(actor, 'supplier.notice_created', 'SupplierNotice', String(n.id), { shopId, all: shopId === null, text }, tx, ['supplier']);
    return { id: n.id };
  });
}

export async function deleteNotice(actor: UserActor, idIn: unknown) {
  assertAdmin(actor);
  const id = Number(idIn);
  const n = Number.isInteger(id) ? await db.supplierNotice.findUnique({ where: { id } }) : null;
  if (!n) throw notFound('Мэдэгдэл олдсонгүй');
  if (n.deletedAt) return { ok: true };
  await db.$transaction(async (tx) => {
    await tx.supplierNotice.update({ where: { id }, data: { deletedAt: new Date(), deletedByName: actor.name } });
    await writeAudit(actor, 'supplier.notice_deleted', 'SupplierNotice', String(id), { shopId: n.shopId, text: n.text }, tx, ['supplier']);
  });
  return { ok: true };
}

async function myShop(userId: string) {
  return db.supplierShop.findUnique({ where: { userId }, select: { id: true, isActive: true } });
}

/** Нийлүүлэгчийн өөрийн мэдэгдлүүд (өөрийн дэлгүүрт + бүгдэд) */
export async function myNotices(user: { id: string; roles: Role[] }) {
  if (!user.roles.includes('SUPPLIER')) return null;
  const s = await myShop(user.id);
  if (!s || !s.isActive) return null;
  const items = await db.supplierNotice.findMany({ where: { deletedAt: null, OR: [{ shopId: null }, { shopId: s.id }] }, orderBy: { id: 'desc' }, take: 20, include: { reads: { where: { shopId: s.id } } } });
  return items.length ? items.map((n) => ({ id: n.id, text: n.text, createdAt: n.createdAt, read: n.reads.length > 0 })) : null;
}

export async function markRead(actor: UserActor, idIn: unknown) {
  if (!actor.roles.includes('SUPPLIER')) throw forbidden();
  const s = await myShop(actor.id);
  if (!s) throw forbidden();
  const id = Number(idIn);
  const n = Number.isInteger(id) ? await db.supplierNotice.findUnique({ where: { id } }) : null;
  if (!n || n.deletedAt || (n.shopId !== null && n.shopId !== s.id)) throw notFound('Мэдэгдэл олдсонгүй');
  await db.supplierNoticeRead.upsert({ where: { noticeId_shopId: { noticeId: id, shopId: s.id } }, create: { noticeId: id, shopId: s.id, readBy: actor.name }, update: {} });
  return { ok: true };
}
