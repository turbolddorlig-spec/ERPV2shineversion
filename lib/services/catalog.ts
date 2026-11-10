import { Prisma } from '@prisma/client';
import { db } from '../db';
import { writeAudit } from '../audit';
import { badRequest, conflict, forbidden, notFound } from '../errors';
import { canManageCatalogLists, canView } from '../permissions';
import type { UserActor } from './users';

/** Ангилал, улирлын жагсаалт (шийдвэр #25, #27) */
export type ListKind = 'categories' | 'seasons';
export const CATEGORY_COLORS = ['gray', 'orange', 'blue', 'green', 'teal', 'violet', 'rose', 'amber'] as const;

function cleanName(v: unknown): string {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (s.length < 2 || s.length > 40) throw badRequest('Нэр 2–40 тэмдэгт байх ёстой');
  return s;
}

function assertKind(kind: string): asserts kind is ListKind {
  if (kind !== 'categories' && kind !== 'seasons') throw notFound();
}

export async function listCatalog(actor: UserActor, kind: string) {
  assertKind(kind);
  if (!canView(actor.roles, 'products') && !canView(actor.roles, 'orders')) throw forbidden();
  if (kind === 'categories') {
    const rows = await db.category.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], include: { _count: { select: { products: true } } } });
    return rows.map((r) => ({ id: r.id, name: r.name, color: r.color, sortOrder: r.sortOrder, isActive: r.isActive, productCount: r._count.products }));
  }
  const rows = await db.season.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], include: { _count: { select: { products: true } } } });
  return rows.map((r) => ({ id: r.id, name: r.name, color: 'gray', sortOrder: r.sortOrder, isActive: r.isActive, productCount: r._count.products }));
}

export async function createCatalogItem(actor: UserActor, kind: string, input: { name?: unknown; color?: unknown }) {
  assertKind(kind);
  if (!canManageCatalogLists(actor.roles)) throw forbidden('Ангилал, улирлыг Супер админ, Админ, Ахлах маркетинг удирдана');
  const name = cleanName(input.name);
  const color = CATEGORY_COLORS.includes(String(input.color) as never) ? String(input.color) : 'gray';
  try {
    return await db.$transaction(async (tx) => {
      const max = kind === 'categories'
        ? (await tx.category.aggregate({ _max: { sortOrder: true } }))._max.sortOrder
        : (await tx.season.aggregate({ _max: { sortOrder: true } }))._max.sortOrder;
      const sortOrder = (max ?? 0) + 1;
      const row = kind === 'categories'
        ? await tx.category.create({ data: { name, color, sortOrder } })
        : await tx.season.create({ data: { name, sortOrder } });
      await writeAudit(actor, `${kind === 'categories' ? 'category' : 'season'}.created`, kind === 'categories' ? 'Category' : 'Season', String(row.id), { name }, tx);
      return row;
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('Ийм нэртэй аль хэдийн байна');
    throw e;
  }
}

export async function updateCatalogItem(actor: UserActor, kind: string, id: number, input: { name?: unknown; color?: unknown; isActive?: unknown; sortOrder?: unknown }) {
  assertKind(kind);
  if (!canManageCatalogLists(actor.roles)) throw forbidden('Ангилал, улирлыг Супер админ, Админ, Ахлах маркетинг удирдана');
  const current = kind === 'categories' ? await db.category.findUnique({ where: { id } }) : await db.season.findUnique({ where: { id } });
  if (!current) throw notFound();
  const data: Record<string, unknown> = {};
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  if (input.name !== undefined) { const n = cleanName(input.name); if (n !== current.name) { data.name = n; changes.name = { from: current.name, to: n }; } }
  if (input.color !== undefined && kind === 'categories') {
    const c = CATEGORY_COLORS.includes(String(input.color) as never) ? String(input.color) : 'gray';
    const prev = 'color' in current ? current.color : 'gray';
    if (c !== prev) { data.color = c; changes.color = { from: prev, to: c }; }
  }
  if (input.isActive !== undefined && Boolean(input.isActive) !== current.isActive) { data.isActive = Boolean(input.isActive); changes.isActive = { from: current.isActive, to: data.isActive }; }
  if (input.sortOrder !== undefined && Number.isInteger(Number(input.sortOrder))) data.sortOrder = Number(input.sortOrder);
  if (Object.keys(data).length === 0) return current;
  try {
    return await db.$transaction(async (tx) => {
      const row = kind === 'categories' ? await tx.category.update({ where: { id }, data }) : await tx.season.update({ where: { id }, data });
      if (Object.keys(changes).length) {
        await writeAudit(actor, `${kind === 'categories' ? 'category' : 'season'}.updated`, kind === 'categories' ? 'Category' : 'Season', String(id), { changes } as Prisma.InputJsonValue, tx);
      }
      return row;
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('Ийм нэртэй аль хэдийн байна');
    throw e;
  }
}
