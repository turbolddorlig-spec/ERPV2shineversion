import type { CallCloseReason, CallStatus, Prisma } from '@prisma/client';
import { db } from '../../db';
import { badRequest, conflict, forbidden, notFound } from '../../errors';
import { writeAudit } from '../../audit';
import { canEditOrders, canSuperviseOperators, canView } from '../../permissions';
import { normalizePhone, isValidPhone } from '../../phone';
import { mediaUrl } from '../../storage';
import { availableFor, type UserActor } from './core';

/**
 * Дуудлагын бүртгэл (хуучин логик, #43 13): Хүлээгдэж буй → Холбогдсон → Захиалсан / Цуцалсан / Шилжүүлсэн.
 * 5 оролдлого, хооронд 30 мин; өөр операторт шилжүүлэх хүсэлт → хүлээн авах/татгалзах; ахлах шууд шилжүүлнэ.
 * Нэмэлт (#54): хаахад шалтгаан заавал, систем урьдчилан сонгоно.
 */
export const CALL_STATUS_LABEL: Record<CallStatus, string> = { PENDING: 'Хүлээгдэж буй', CONTACTED: 'Холбогдсон', ORDERED: 'Захиалсан', CANCELLED: 'Цуцалсан', TRANSFERRED: 'Шилжүүлсэн' };
export const CLOSE_LABEL: Record<CallCloseReason, string> = {
  NO_ANSWER: 'Утсаа аваагүй', PRICE: 'Үнэ үнэтэй', OUT_OF_STOCK: 'Бараа дууссан', NO_SIZE_COLOR: 'Өнгө, хэмжээ байхгүй',
  DELIVERY: 'Хүргэлт', JUST_ASKING: 'Зүгээр асуусан', BOUGHT_ELSEWHERE: 'Өөр газраас авсан', OTHER: 'Бусад',
};
export const MAX_ATTEMPTS = 5;
export const ATTEMPT_GAP_MIN = 30;

const assertEdit = (a: UserActor) => { if (!canEditOrders(a.roles)) throw forbidden(); };

export async function createCallNotes(actor: UserActor, input: { phones?: unknown; variantId?: unknown; productText?: unknown; pageId?: unknown; note?: unknown }) {
  assertEdit(actor);
  const phones = [...new Set(String(input.phones ?? '').split(/[\s,;]+/).map((p) => normalizePhone(p)).filter(Boolean))];
  if (!phones.length) throw badRequest('Утасны дугаар оруулна уу');
  if (phones.length > 100) throw badRequest('Нэг дор 100 хүртэл дугаар');
  const bad = phones.filter((p) => !isValidPhone(p));
  if (bad.length) throw badRequest(`8 оронтой биш дугаар: ${bad.slice(0, 5).join(', ')}`, 'bad_phone');
  const variantId = input.variantId ? Number(input.variantId) : null;
  if (variantId && !(await db.productVariant.findUnique({ where: { id: variantId } }))) throw badRequest('Бараа олдсонгүй');
  const pageId = input.pageId ? Number(input.pageId) : null;
  if (pageId && !(await db.page.findUnique({ where: { id: pageId } }))) throw badRequest('Пэйж олдсонгүй');
  const productText = String(input.productText ?? '').trim().slice(0, 120) || null;
  const note = String(input.note ?? '').trim().slice(0, 500) || null;
  const r = await db.callNote.createMany({ data: phones.map((phone) => ({ phone, variantId, productText, pageId, note, ownerId: actor.id, ownerName: actor.name, createdById: actor.id })) });
  return { created: r.count };
}

export async function listCallNotes(actor: UserActor, p: { status?: string; ownerId?: string; q?: string; page?: number }) {
  if (!canView(actor.roles, 'orders')) throw forbidden();
  const sup = canSuperviseOperators(actor.roles);
  const and: Prisma.CallNoteWhereInput[] = [];
  if (!sup) and.push({ ownerId: actor.id });
  else if (p.ownerId) and.push({ ownerId: p.ownerId });
  if (p.status === 'open' || !p.status) and.push({ status: { in: ['PENDING', 'CONTACTED'] } });
  else if (p.status !== 'all') and.push({ status: p.status as CallStatus });
  const q = (p.q ?? '').replace(/\D/g, '');
  if (q) and.push({ phone: { contains: q } });
  const page = Math.max(1, Math.floor(p.page ?? 1));
  const where = { AND: and };
  const [total, rows, incoming] = await Promise.all([
    db.callNote.count({ where }),
    db.callNote.findMany({ where, orderBy: [{ status: 'asc' }, { id: 'desc' }], skip: (page - 1) * 50, take: 50 }),
    db.callNoteTransfer.findMany({ where: { toId: actor.id, status: 'PENDING' }, include: { note: true }, orderBy: { id: 'desc' }, take: 100 }),
  ]);
  const vids = [...new Set([...rows, ...incoming.map((t) => t.note)].map((n) => n.variantId).filter((x): x is number => !!x))];
  const [variants, pages] = await Promise.all([
    vids.length ? db.productVariant.findMany({ where: { id: { in: vids } }, select: { id: true, code: true, color: true, size: true, product: { select: { name: true, images: { where: { isMain: true }, take: 1, select: { fileKey: true } } } } } }) : [],
    db.page.findMany({ select: { id: true, name: true } }),
  ]);
  const vm = new Map(variants.map((v) => [v.id, v]));
  const pm = new Map(pages.map((x) => [x.id, x.name]));
  const now = Date.now();
  const ser = (n: (typeof rows)[number]) => {
    const v = n.variantId ? vm.get(n.variantId) : undefined;
    const nextAt = n.lastAttemptAt ? n.lastAttemptAt.getTime() + ATTEMPT_GAP_MIN * 60_000 : 0;
    return {
      id: n.id, phone: n.phone, note: n.note, status: n.status, statusLabel: CALL_STATUS_LABEL[n.status], ownerId: n.ownerId, ownerName: n.ownerName,
      attempts: n.attempts, lastAttemptAt: n.lastAttemptAt, canAttemptAt: nextAt > now ? new Date(nextAt) : null,
      variantId: n.variantId, product: v ? `${v.product.name}${v.color || v.size ? ` · ${[v.color, v.size].filter(Boolean).join(' · ')}` : ''}` : n.productText, productCode: v?.code ?? null,
      thumb: v?.product.images[0] ? mediaUrl(v.product.images[0].fileKey, 'sm') : null,
      pageId: n.pageId, pageName: n.pageId ? pm.get(n.pageId) ?? null : null, orderId: n.orderId,
      closeReason: n.closeReason, closeLabel: n.closeReason ? CLOSE_LABEL[n.closeReason] : null, closeNote: n.closeNote, createdAt: n.createdAt,
    };
  };
  return {
    total, page, pageSize: 50, supervise: sup,
    items: rows.map(ser),
    incoming: incoming.map((t) => ({ transferId: t.id, fromName: t.fromName, createdAt: t.createdAt, note: ser(t.note) })),
  };
}

async function loadOwned(actor: UserActor, id: number) {
  const n = await db.callNote.findUnique({ where: { id } });
  if (!n) throw notFound('Тэмдэглэл олдсонгүй');
  if (n.ownerId !== actor.id && !canSuperviseOperators(actor.roles)) throw forbidden('Энэ тэмдэглэл таных биш');
  return n;
}

/** Залгасан (оролдлого +1): 5 хүртэл, хооронд 30 мин */
export async function attemptCall(actor: UserActor, idInput: unknown) {
  assertEdit(actor);
  const n = await loadOwned(actor, Number(idInput));
  if (!['PENDING', 'CONTACTED'].includes(n.status)) throw conflict('Хаагдсан тэмдэглэл');
  if (n.attempts >= MAX_ATTEMPTS) throw conflict(`${MAX_ATTEMPTS} оролдлого дууссан — тэмдэглэлээ хаана уу`, 'max_attempts');
  if (n.lastAttemptAt && Date.now() - n.lastAttemptAt.getTime() < ATTEMPT_GAP_MIN * 60_000) throw conflict(`Дахин залгахад ${ATTEMPT_GAP_MIN} минут хүлээнэ`, 'too_soon');
  // Давхар даралтаас: attempts тоогоор нөхцөлтэй
  const r = await db.callNote.updateMany({ where: { id: n.id, attempts: n.attempts }, data: { attempts: { increment: 1 }, lastAttemptAt: new Date(), status: 'CONTACTED' } });
  return { updated: r.count };
}

/** Хаах шалтгааны санал (#54): 5 оролдлого → Утсаа аваагүй; бараа үлдэгдэлгүй → Бараа дууссан */
export async function suggestCloseReason(actor: UserActor, idInput: unknown): Promise<{ reason: CallCloseReason | null }> {
  const n = await loadOwned(actor, Number(idInput));
  if (n.attempts >= MAX_ATTEMPTS) return { reason: 'NO_ANSWER' };
  if (n.variantId) {
    const av = await availableFor(db, [n.variantId]);
    if ((av.get(n.variantId) ?? 0) <= 0) return { reason: 'OUT_OF_STOCK' };
  }
  return { reason: n.attempts > 0 ? 'NO_ANSWER' : null };
}

const REASONS = Object.keys(CLOSE_LABEL) as CallCloseReason[];

export async function closeCallNote(actor: UserActor, idInput: unknown, input: { reason?: unknown; note?: unknown }) {
  assertEdit(actor);
  const n = await loadOwned(actor, Number(idInput));
  if (!['PENDING', 'CONTACTED'].includes(n.status)) return n;
  const reason = String(input.reason ?? '') as CallCloseReason;
  if (!REASONS.includes(reason)) throw badRequest('Шалтгаанаа сонгоно уу', 'reason_required');
  const note = String(input.note ?? '').trim().slice(0, 300) || null;
  if (reason === 'OTHER' && (!note || note.replace(/\s/g, '').length < 3)) throw badRequest('«Бусад» шалтгааныг бичнэ үү', 'reason_required');
  return db.callNote.update({ where: { id: n.id }, data: { status: 'CANCELLED', closeReason: reason, closeNote: note, closedAt: new Date() } });
}

/** Өөр операторт шилжүүлэх хүсэлт (хуучин логик) */
export async function requestTransfer(actor: UserActor, idInput: unknown, input: { toUserId?: unknown }) {
  assertEdit(actor);
  const n = await loadOwned(actor, Number(idInput));
  if (!['PENDING', 'CONTACTED'].includes(n.status)) throw conflict('Хаагдсан тэмдэглэл');
  const to = await db.user.findUnique({ where: { id: String(input.toUserId ?? '') } });
  if (!to || !to.isActive || !canEditOrders(to.roles)) throw badRequest('Оператор олдсонгүй');
  if (to.id === n.ownerId) throw badRequest('Өөрт нь шилжүүлэх боломжгүй');
  const open = await db.callNoteTransfer.findFirst({ where: { noteId: n.id, status: 'PENDING' } });
  if (open) throw conflict('Энэ тэмдэглэлийн шилжүүлэх хүсэлт хүлээгдэж байна');
  return db.callNoteTransfer.create({ data: { noteId: n.id, fromId: actor.id, fromName: actor.name, toId: to.id, toName: to.name } });
}

export async function decideTransfer(actor: UserActor, transferIdInput: unknown, input: { accept?: unknown }) {
  assertEdit(actor);
  const t = await db.callNoteTransfer.findUnique({ where: { id: Number(transferIdInput) } });
  if (!t) throw notFound();
  if (t.toId !== actor.id) throw forbidden('Энэ хүсэлт танд биш');
  if (t.status !== 'PENDING') return t;
  const accept = input.accept === true;
  return db.$transaction(async (tx) => {
    const ok = await tx.callNoteTransfer.updateMany({ where: { id: t.id, status: 'PENDING' }, data: { status: accept ? 'ACCEPTED' : 'REJECTED', decidedAt: new Date() } });
    if (ok.count && accept) await tx.callNote.update({ where: { id: t.noteId }, data: { ownerId: actor.id, ownerName: actor.name } });
    return tx.callNoteTransfer.findUniqueOrThrow({ where: { id: t.id } });
  });
}

/** Ахлах оператор шууд (олноор) шилжүүлнэ */
export async function reassignCallNotes(actor: UserActor, input: { ids?: unknown; toUserId?: unknown }) {
  if (!canSuperviseOperators(actor.roles)) throw forbidden('Шууд шилжүүлэхийг ахлах оператор хийнэ');
  const to = await db.user.findUnique({ where: { id: String(input.toUserId ?? '') } });
  if (!to || !to.isActive || !canEditOrders(to.roles)) throw badRequest('Оператор олдсонгүй');
  if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > 500) throw badRequest('Тэмдэглэл сонгоно уу');
  const ids = (input.ids as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  return db.$transaction(async (tx) => {
    const r = await tx.callNote.updateMany({ where: { id: { in: ids }, status: { in: ['PENDING', 'CONTACTED'] } }, data: { ownerId: to.id, ownerName: to.name } });
    await writeAudit(actor, 'calls.reassigned', 'CallNote', null, { to: to.name, count: r.count }, tx, ['order']);
    return { moved: r.count };
  });
}

/** Шилжүүлэх боломжтой операторууд */
export async function operatorsList(actor: UserActor) {
  if (!canView(actor.roles, 'orders')) throw forbidden();
  return db.user.findMany({ where: { isActive: true, roles: { hasSome: ['OPERATOR', 'OPERATOR_LEAD', 'ADMIN', 'SUPER_ADMIN'] } }, orderBy: { name: 'asc' }, select: { id: true, name: true } });
}
