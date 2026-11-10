import type { Prisma } from '@prisma/client';
import { db } from '../../db';
import { badRequest, conflict, notFound } from '../../errors';
import { writeAudit } from '../../audit';
import { canApproveStock, canView } from '../../permissions';
import { cleanId, requireRole, uniqueViolation, type UserActor } from './core';

/** Агуулахууд (#38: 6 агуулах, 1 үндсэн). Удирдах — Супер админ / Админ. */
export async function listWarehouses(actor: UserActor, opts: { includeInactive?: boolean } = {}) {
  requireRole(canView(actor.roles, 'warehouse') || canView(actor.roles, 'loans'));
  return db.warehouse.findMany({
    where: opts.includeInactive ? {} : { isActive: true },
    orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true, address: true, isPrimary: true, isActive: true, sortOrder: true, location: { select: { id: true } } },
  }).then((rows) => rows.map(({ location, ...w }) => ({ ...w, locationId: location?.id ?? null })));
}

function cleanName(v: unknown): string {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (s.length < 2 || s.length > 60) throw badRequest('Агуулахын нэр 2–60 тэмдэгт');
  return s;
}
const cleanAddress = (v: unknown) => String(v ?? '').trim().slice(0, 200) || null;

export async function createWarehouse(actor: UserActor, input: { name?: unknown; address?: unknown }) {
  requireRole(canApproveStock(actor.roles), 'Агуулахыг Супер админ, Админ үүсгэнэ');
  const name = cleanName(input.name);
  const address = cleanAddress(input.address);
  try {
    return await db.$transaction(async (tx) => {
      const hasPrimary = (await tx.warehouse.count({ where: { isPrimary: true } })) > 0;
      const max = await tx.warehouse.aggregate({ _max: { sortOrder: true } });
      const w = await tx.warehouse.create({ data: { name, address, isPrimary: !hasPrimary, sortOrder: (max._max.sortOrder ?? 0) + 1 } });
      await tx.stockLocation.create({ data: { kind: 'WAREHOUSE', warehouseId: w.id, name } });
      await writeAudit(actor, 'warehouse.created', 'Warehouse', String(w.id), { name, address, isPrimary: w.isPrimary }, tx);
      return w;
    });
  } catch (e) {
    if (uniqueViolation(e)) throw conflict(`«${name}» нэртэй агуулах бий`, 'name_taken');
    throw e;
  }
}

export async function updateWarehouse(actor: UserActor, idInput: unknown, input: { name?: unknown; address?: unknown; sortOrder?: unknown; isPrimary?: unknown; isActive?: unknown }) {
  requireRole(canApproveStock(actor.roles), 'Агуулахыг Супер админ, Админ засна');
  const id = cleanId(idInput, 'Агуулах');
  const w = await db.warehouse.findUnique({ where: { id }, include: { location: true } });
  if (!w || !w.location) throw notFound('Агуулах олдсонгүй');
  const data: { name?: string; address?: string | null; sortOrder?: number; isActive?: boolean } = {};
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  if (input.name !== undefined) { const n = cleanName(input.name); if (n !== w.name) { data.name = n; changes.name = { from: w.name, to: n }; } }
  if (input.address !== undefined) { const a = cleanAddress(input.address); if (a !== w.address) { data.address = a; changes.address = { from: w.address, to: a }; } }
  if (input.sortOrder !== undefined) { const n = Number(input.sortOrder); if (Number.isInteger(n) && n !== w.sortOrder) data.sortOrder = n; }
  if (input.isActive === false && w.isActive) {
    if (w.isPrimary) throw badRequest('Үндсэн агуулахыг хаахгүй. Эхлээд өөр агуулахыг үндсэн болгоно уу.');
    // Үлдэгдэлтэй, нээлттэй шилжүүлэг/тооллоготой агуулахыг хаахгүй — эхлээд шилжүүлнэ (хуучин "алга болох" алдааг хаана)
    const stock = await db.stockBalance.aggregate({ where: { locationId: w.location.id, qty: { gt: 0 } }, _sum: { qty: true } });
    if ((stock._sum.qty ?? 0) > 0) throw badRequest(`«${w.name}»-д ${stock._sum.qty} ширхэг бараа байна. Эхлээд өөр агуулах руу шилжүүлнэ үү.`, 'warehouse_not_empty');
    const open = await db.stockTransfer.count({ where: { status: { in: ['SENT', 'DISCREPANCY'] }, OR: [{ fromWarehouseId: id }, { toWarehouseId: id }] } });
    if (open) throw badRequest('Энэ агуулахын дуусаагүй шилжүүлэг байна', 'warehouse_busy');
    const counts = await db.stockCount.count({ where: { warehouseId: id, status: { in: ['OPEN', 'SUBMITTED'] } } });
    if (counts) throw badRequest('Энэ агуулахад дуусаагүй тооллого байна', 'warehouse_busy');
    data.isActive = false; changes.isActive = { from: true, to: false };
  }
  if (input.isActive === true && !w.isActive) { data.isActive = true; changes.isActive = { from: false, to: true }; }
  const makePrimary = input.isPrimary === true && !w.isPrimary;
  if (makePrimary && !(data.isActive ?? w.isActive)) throw badRequest('Хаагдсан агуулахыг үндсэн болгохгүй');
  try {
    return await db.$transaction(async (tx) => {
      if (makePrimary) {
        await tx.warehouse.updateMany({ where: { isPrimary: true }, data: { isPrimary: false } });
        changes.isPrimary = { from: false, to: true };
      }
      const u = await tx.warehouse.update({ where: { id }, data: { ...data, ...(makePrimary ? { isPrimary: true } : {}) } });
      if (data.name) await tx.stockLocation.update({ where: { id: w.location!.id }, data: { name: data.name } });
      if (Object.keys(changes).length) await writeAudit(actor, 'warehouse.updated', 'Warehouse', String(id), { name: u.name, changes } as unknown as Prisma.InputJsonValue, tx);
      return u;
    });
  } catch (e) {
    if (uniqueViolation(e)) throw conflict('Ийм нэртэй агуулах бий', 'name_taken');
    throw e;
  }
}

/** Үндсэн агуулах (захиалга, дүүргэлт) */
export async function primaryWarehouse() {
  return db.warehouse.findFirst({ where: { isPrimary: true, isActive: true }, include: { location: true } });
}
