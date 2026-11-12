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
  const r = await db.$transaction(async (tx) => {
    const r = await tx.callNote.createMany({ data: phones.map((phone) => ({ phone, variantId, productText, pageId, note, ownerId: actor.id, ownerName: actor.name, createdById: actor.id })) });
    await writeAudit(actor, 'calls.created', 'CallNote', null, { count: r.count, phones: phones.slice(0, 20), productText, variantId, pageId }, tx, ['order']);
    return r;
  });
  return { created: r.count };
}

export async function listCallNotes(actor: UserActor, p: { status?: string; ownerId?: string; q?: string; page?: number; scope?: string }) {
  if (!canView(actor.roles, 'orders')) throw forbidden();
  const sup = canSuperviseOperators(actor.roles);
  // Хуучин шиг: анхдагч «Зөвхөн минийх»; ахлах «Бүх оператор» сонгож болно
  const all = sup && (p.scope === 'all' || !!p.ownerId);
  const base: Prisma.CallNoteWhereInput[] = [];
  if (!all) base.push({ ownerId: actor.id });
  else if (p.ownerId) base.push({ ownerId: p.ownerId });
  const q = (p.q ?? '').replace(/\D/g, '');
  if (q) base.push({ phone: { contains: q } });
  const and = [...base];
  if (p.status === 'open' || !p.status) and.push({ status: { in: ['PENDING', 'CONTACTED'] } });
  else if (p.status !== 'all') and.push({ status: p.status as CallStatus });
  const page = Math.max(1, Math.floor(p.page ?? 1));
  const where = { AND: and };
  const [total, rows, incoming, grouped] = await Promise.all([
    db.callNote.count({ where }),
    db.callNote.findMany({ where, orderBy: [{ status: 'asc' }, { id: 'desc' }], skip: (page - 1) * 50, take: 50 }),
    db.callNoteTransfer.findMany({ where: { toId: actor.id, status: 'PENDING' }, include: { note: true }, orderBy: { id: 'desc' }, take: 100 }),
    db.callNote.groupBy({ by: ['status'], where: { AND: base }, _count: true }),
  ]);
  const counts = Object.fromEntries(grouped.map((g) => [g.status, g._count])) as Partial<Record<CallStatus, number>>;
  const [outgoing, orders] = await Promise.all([
    db.callNoteTransfer.findMany({ where: { noteId: { in: rows.map((r) => r.id) }, status: 'PENDING' }, select: { noteId: true, toName: true } }),
    db.order.findMany({ where: { id: { in: rows.map((r) => r.orderId).filter((x): x is number => !!x) } }, select: { id: true, number: true } }),
  ]);
  const outMap = new Map(outgoing.map((t) => [t.noteId, t.toName]));
  const ordMap = new Map(orders.map((o) => [o.id, o.number]));
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
      pageId: n.pageId, pageName: n.pageId ? pm.get(n.pageId) ?? null : null, orderId: n.orderId, orderNumber: n.orderId ? ordMap.get(n.orderId) ?? null : null,
      pendingTransferTo: outMap.get(n.id) ?? null,
      closeReason: n.closeReason, closeLabel: n.closeReason ? CLOSE_LABEL[n.closeReason] : null, closeNote: n.closeNote, createdAt: n.createdAt,
    };
  };
  return {
    total, page, pageSize: 50, supervise: sup, scope: all ? 'all' : 'own', counts,
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
  if (r.count) await writeAudit(actor, 'calls.attempt', 'CallNote', String(n.id), { phone: n.phone, attempt: n.attempts + 1 }, db, ['order']);
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
  // Зэрэг «Захиалга үүссэн» болсон бол дарж бичихгүй (аудит)
  return db.$transaction(async (tx) => {
    const u = await tx.callNote.updateMany({ where: { id: n.id, status: { in: ['PENDING', 'CONTACTED'] } }, data: { status: 'CANCELLED', closeReason: reason, closeNote: note, closedAt: new Date() } });
    if (u.count) await writeAudit(actor, 'calls.closed', 'CallNote', String(n.id), { phone: n.phone, reason: CLOSE_LABEL[reason], note }, tx, ['order']);
    return tx.callNote.findUniqueOrThrow({ where: { id: n.id } });
  });
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
  return db.$transaction(async (tx) => {
    const t = await tx.callNoteTransfer.create({ data: { noteId: n.id, fromId: actor.id, fromName: actor.name, toId: to.id, toName: to.name } });
    await writeAudit(actor, 'calls.transfer_requested', 'CallNote', String(n.id), { phone: n.phone, from: n.ownerName, to: to.name }, tx, ['order']);
    return t;
  });
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
    // Хаагдсан / захиалга болсон тэмдэглэлийн эзнийг солихгүй
    if (ok.count && accept) await tx.callNote.updateMany({ where: { id: t.noteId, status: { in: ['PENDING', 'CONTACTED'] } }, data: { ownerId: actor.id, ownerName: actor.name } });
    if (ok.count) await writeAudit(actor, accept ? 'calls.transfer_accepted' : 'calls.transfer_rejected', 'CallNote', String(t.noteId), { from: t.fromName, to: t.toName }, tx, ['order']);
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

/** Бөөнөөр шилжүүлэх хүсэлт (оператор өөрийн нээлттэй бүртгэлүүдээ) — нэг гүйлгээнд; тохирохгүйг алгасна */
export async function requestTransfers(actor: UserActor, input: { ids?: unknown; toUserId?: unknown }) {
  assertEdit(actor);
  const ids = Array.isArray(input.ids) ? [...new Set((input.ids as unknown[]).map(Number))].filter((n) => Number.isInteger(n) && n > 0) : [];
  if (!ids.length || ids.length > 500) throw badRequest('Бүртгэл сонгоно уу');
  const to = await db.user.findUnique({ where: { id: String(input.toUserId ?? '') } });
  if (!to || !to.isActive || !canEditOrders(to.roles)) throw badRequest('Оператор олдсонгүй');
  const sup = canSuperviseOperators(actor.roles);
  return db.$transaction(async (tx) => {
    // Аудит А2 (#70): энгийн оператор зөвхөн ӨӨРИЙН тэмдэглэлийг (өмнө нь ownerId түлхүүр дарагдаж бусдынх ч орж байв)
    const notes = await tx.callNote.findMany({ where: { id: { in: ids }, status: { in: ['PENDING', 'CONTACTED'] }, AND: [{ ownerId: { not: to.id } }, ...(sup ? [] : [{ ownerId: actor.id }])] } });
    const pending = new Set((await tx.callNoteTransfer.findMany({ where: { noteId: { in: notes.map((n) => n.id) }, status: 'PENDING' }, select: { noteId: true } })).map((t) => t.noteId));
    const ok = notes.filter((n) => !pending.has(n.id));
    if (ok.length) {
      await tx.callNoteTransfer.createMany({ data: ok.map((n) => ({ noteId: n.id, fromId: actor.id, fromName: actor.name, toId: to.id, toName: to.name })) });
      await writeAudit(actor, 'calls.transfer_requested', 'CallNote', null, { to: to.name, count: ok.length, ids: ok.slice(0, 50).map((n) => n.id) }, tx, ['order']);
    }
    return { requested: ok.length, skipped: ids.length - ok.length };
  });
}

/** Ирсэн хүсэлтүүдийг бөөнөөр хүлээн авах / татгалзах (ids эсвэл 'all') */
export async function decideTransfers(actor: UserActor, input: { ids?: unknown; accept?: unknown }) {
  assertEdit(actor);
  const accept = input.accept === true;
  const where = input.ids === 'all'
    ? { toId: actor.id, status: 'PENDING' as const }
    : { toId: actor.id, status: 'PENDING' as const, id: { in: (Array.isArray(input.ids) ? (input.ids as unknown[]).map(Number) : []).filter((n) => Number.isInteger(n) && n > 0) } };
  return db.$transaction(async (tx) => {
    const ts = await tx.callNoteTransfer.findMany({ where, select: { id: true, noteId: true }, take: 1000 });
    if (!ts.length) return { decided: 0 };
    const r = await tx.callNoteTransfer.updateMany({ where: { id: { in: ts.map((t) => t.id) }, status: 'PENDING' }, data: { status: accept ? 'ACCEPTED' : 'REJECTED', decidedAt: new Date() } });
    if (accept) await tx.callNote.updateMany({ where: { id: { in: ts.map((t) => t.noteId) }, status: { in: ['PENDING', 'CONTACTED'] } }, data: { ownerId: actor.id, ownerName: actor.name } });
    if (r.count) await writeAudit(actor, accept ? 'calls.transfer_accepted' : 'calls.transfer_rejected', 'CallNote', null, { count: r.count }, tx, ['order']);
    return { decided: r.count };
  });
}
