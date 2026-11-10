import { db } from '../../db';
import { badRequest, conflict, forbidden, notFound } from '../../errors';
import { writeAudit } from '../../audit';
import { canEditOrders, canManageOrderSettings, canSuperviseOperators, canView } from '../../permissions';
import { NO_PAGE_NAME, SETTINGS, cleanPhone, orderSettings, requireReason, uniqueViolation, type UserActor } from './core';

// ───────────────────────── хар жагсаалт (#43 4) ─────────────────────────

export async function listBlacklist(actor: UserActor, p: { q?: string; page?: number }) {
  if (!canView(actor.roles, 'orders')) throw forbidden();
  const page = Math.max(1, Math.floor(p.page ?? 1));
  const q = (p.q ?? '').replace(/\D/g, '');
  const where = { isActive: true, ...(q ? { phone: { contains: q } } : {}) };
  const [total, items] = await Promise.all([
    db.blacklistEntry.count({ where }),
    db.blacklistEntry.findMany({ where, orderBy: { id: 'desc' }, skip: (page - 1) * 50, take: 50 }),
  ]);
  return { total, page, pageSize: 50, canManage: canSuperviseOperators(actor.roles), items };
}

export async function addBlacklist(actor: UserActor, input: { phone?: unknown; reason?: unknown; orderNumber?: unknown }) {
  if (!canSuperviseOperators(actor.roles)) throw forbidden('Хар жагсаалтыг ахлах оператор, админ удирдана');
  const phone = cleanPhone(input.phone);
  const reason = requireReason(input.reason);
  const e = await db.$transaction(async (tx) => {
    const r = await tx.blacklistEntry.create({ data: { phone, reason, orderNumber: input.orderNumber ? String(input.orderNumber).slice(0, 20) : null, reportedById: actor.id, reportedBy: actor.name } });
    await writeAudit(actor, 'blacklist.added', 'BlacklistEntry', String(r.id), { phone, reason }, tx, ['order']);
    return r;
  });
  return e;
}

export async function removeBlacklist(actor: UserActor, idInput: unknown, input: { note?: unknown }) {
  if (!canSuperviseOperators(actor.roles)) throw forbidden('Хар жагсаалтыг ахлах оператор, админ удирдана');
  const id = Number(idInput);
  const note = requireReason(input.note);
  const e = await db.blacklistEntry.findUnique({ where: { id } });
  if (!e) throw notFound();
  if (!e.isActive) return e;
  return db.$transaction(async (tx) => {
    const r = await tx.blacklistEntry.update({ where: { id }, data: { isActive: false, removedBy: actor.name, removedAt: new Date(), removeNote: note } });
    await writeAudit(actor, 'blacklist.removed', 'BlacklistEntry', String(id), { phone: e.phone, note }, tx, ['order']);
    return r;
  });
}

// ───────────────────────── пэйж ба хуваарилалт (хуучин шиг) ─────────────────────────

/** Операторт харагдах пэйжүүд: хуваарилалт байвал түүгээр, үгүй бол бүх идэвхтэй; сүүлд сонгосон нь эхэнд */
export async function pagesForActor(actor: UserActor) {
  if (!canView(actor.roles, 'orders') && !canView(actor.roles, 'reports')) throw forbidden();
  const [pages, assign, me] = await Promise.all([
    db.page.findMany({ where: { isActive: true, name: { not: NO_PAGE_NAME } }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }),
    db.pageAssignment.findUnique({ where: { userId: actor.id } }),
    db.user.findUnique({ where: { id: actor.id }, select: { lastPageId: true } }),
  ]);
  const allowed = !canSuperviseOperators(actor.roles) && assign?.pageIds.length ? pages.filter((p) => assign.pageIds.includes(p.id)) : pages;
  const last = allowed.some((p) => p.id === me?.lastPageId) ? me!.lastPageId : allowed[0]?.id ?? null;
  // Хүргэлтийн төлбөрийн дүнг маягтад урьдчилж харуулна (эцсийн дүнг сервер тооцно)
  const { feeUB, feeRural } = await orderSettings();
  return { pages: allowed.map((p) => ({ id: p.id, name: p.name })), lastPageId: last, fees: { feeUB, feeRural } };
}

export async function listAllPages(actor: UserActor) {
  if (!canManageOrderSettings(actor.roles) && !canSuperviseOperators(actor.roles)) throw forbidden();
  return db.page.findMany({ where: { name: { not: NO_PAGE_NAME } }, orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { id: 'asc' }] });
}

export async function savePage(actor: UserActor, input: { id?: unknown; name?: unknown; isActive?: unknown; sortOrder?: unknown }) {
  if (!canManageOrderSettings(actor.roles)) throw forbidden('Пэйжийг Супер админ, Админ удирдана');
  const name = String(input.name ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 80) throw badRequest('Пэйжийн нэр 2–80 тэмдэгт');
  if (name === NO_PAGE_NAME) throw badRequest('Энэ нэр системд хадгалагдсан');
  if (input.id && (await db.page.findUnique({ where: { id: Number(input.id) } }))?.name === NO_PAGE_NAME) throw badRequest('«Пэйж сонгоогүй»-г өөрчлөх боломжгүй');
  try {
    return await db.$transaction(async (tx) => {
      const id = input.id ? Number(input.id) : null;
      const data = { name, ...(typeof input.isActive === 'boolean' ? { isActive: input.isActive } : {}), ...(Number.isInteger(Number(input.sortOrder)) ? { sortOrder: Number(input.sortOrder) } : {}) };
      const p = id ? await tx.page.update({ where: { id }, data }) : await tx.page.create({ data });
      await writeAudit(actor, id ? 'page.updated' : 'page.created', 'Page', String(p.id), data, tx, ['settings']);
      return p;
    });
  } catch (e) {
    if (uniqueViolation(e)) throw conflict('Ийм нэртэй пэйж бий', 'name_taken');
    throw e;
  }
}

/** Пэйж хуваарилалт: операторууд ба тэдний пэйжүүд */
export async function listAssignments(actor: UserActor) {
  if (!canSuperviseOperators(actor.roles)) throw forbidden();
  const [ops, assigns] = await Promise.all([
    db.user.findMany({ where: { isActive: true, roles: { hasSome: ['OPERATOR', 'OPERATOR_LEAD'] } }, orderBy: { name: 'asc' }, select: { id: true, name: true, phone: true } }),
    db.pageAssignment.findMany(),
  ]);
  const m = new Map(assigns.map((a) => [a.userId, a.pageIds]));
  return ops.map((o) => ({ ...o, pageIds: m.get(o.id) ?? [] }));
}

export async function setAssignment(actor: UserActor, input: { userId?: unknown; pageIds?: unknown }) {
  if (!canSuperviseOperators(actor.roles)) throw forbidden('Пэйжийг ахлах оператор хуваарилна');
  const userId = String(input.userId ?? '');
  const u = await db.user.findUnique({ where: { id: userId } });
  if (!u || !canEditOrders(u.roles)) throw badRequest('Оператор олдсонгүй');
  if (!Array.isArray(input.pageIds)) throw badRequest('Пэйж сонгоно уу');
  const pageIds = [...new Set((input.pageIds as unknown[]).map(Number))].filter((n) => Number.isInteger(n) && n > 0);
  if ((await db.page.count({ where: { id: { in: pageIds } } })) !== pageIds.length) throw badRequest('Пэйж олдсонгүй');
  await db.$transaction(async (tx) => {
    await tx.pageAssignment.upsert({ where: { userId }, create: { userId, pageIds, updatedBy: actor.name }, update: { pageIds, updatedBy: actor.name } });
    await writeAudit(actor, 'page.assigned', 'User', userId, { name: u.name, pageIds }, tx, ['order']);
  });
  return { userId, pageIds };
}

// ───────────────────────── захиалгын тохиргоо ─────────────────────────

export async function getOrderSettings(actor: UserActor) {
  if (!canManageOrderSettings(actor.roles)) throw forbidden();
  return orderSettings();
}

export async function setOrderSettings(actor: UserActor, input: { feeUB?: unknown; feeRural?: unknown; waitDays?: unknown }) {
  if (!canManageOrderSettings(actor.roles)) throw forbidden();
  const cur = await orderSettings();
  const upd: [string, number, number][] = [];
  const num = (v: unknown, max: number, label: string) => { const n = Number(v); if (!Number.isInteger(n) || n < 0 || n > max) throw badRequest(`${label} буруу`); return n; };
  if (input.feeUB !== undefined) upd.push([SETTINGS.feeUB, num(input.feeUB, 1_000_000, 'УБ хүргэлтийн төлбөр'), cur.feeUB]);
  if (input.feeRural !== undefined) upd.push([SETTINGS.feeRural, num(input.feeRural, 1_000_000, 'Орон нутгийн хүргэлтийн төлбөр'), cur.feeRural]);
  if (input.waitDays !== undefined) { const d = num(input.waitDays, 60, 'Хоног'); if (d < 1) throw badRequest('Хоног 1–60'); upd.push([SETTINGS.waitDays, d, cur.waitDays]); }
  await db.$transaction(async (tx) => {
    for (const [key, value] of upd) await tx.appSetting.upsert({ where: { key }, create: { key, value, updatedById: actor.id }, update: { value, updatedById: actor.id } });
    await writeAudit(actor, 'settings.orders', 'AppSetting', 'orders', { changes: upd.map(([k, to, from]) => ({ key: k, from, to })) }, tx, ['settings', 'money']);
  });
  return orderSettings();
}
