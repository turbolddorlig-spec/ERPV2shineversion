import { Prisma, type PrismaClient } from '@prisma/client';

/**
 * Олон өдрийн сценарид (#157): Prisma-ийн @default(now()) / @updatedAt талбарыг JS-ийн (тестийн) цагаар бөглөнө.
 * Prisma-ийн engine өөрийн жинхэнэ цагийг хэрэглэдэг тул — зөвхөн тестэд, бодит кодонд хүрэхгүй.
 */
export function installSimClock(db: PrismaClient) {
  const nowF = new Map<string, string[]>(); const updF = new Map<string, string[]>();
  for (const m of Prisma.dmmf.datamodel.models) {
    nowF.set(m.name, m.fields.filter((f) => f.type === 'DateTime' && f.hasDefaultValue && typeof f.default === 'object' && f.default && (f.default as { name?: string }).name === 'now').map((f) => f.name));
    updF.set(m.name, m.fields.filter((f) => f.isUpdatedAt).map((f) => f.name));
  }
  const fill = (model: string, d: Record<string, unknown> | undefined, create: boolean) => {
    if (!d || typeof d !== 'object') return;
    const t = new Date();
    if (create) for (const f of nowF.get(model) ?? []) if (d[f] === undefined) d[f] = t;
    for (const f of updF.get(model) ?? []) if (d[f] === undefined) d[f] = t;
  };
  (db as unknown as { $use: (fn: (p: Prisma.MiddlewareParams, next: (p: Prisma.MiddlewareParams) => Promise<unknown>) => Promise<unknown>) => void }).$use(async (p, next) => {
    const m = p.model; const a = p.args as Record<string, unknown> | undefined;
    if (m && a) {
      if (p.action === 'create') fill(m, a.data as Record<string, unknown>, true);
      else if (p.action === 'createMany') { const d = a.data; if (Array.isArray(d)) d.forEach((x) => fill(m, x, true)); else fill(m, d as Record<string, unknown>, true); }
      else if (p.action === 'upsert') { fill(m, a.create as Record<string, unknown>, true); fill(m, a.update as Record<string, unknown>, false); }
      else if (p.action === 'update' || p.action === 'updateMany') fill(m, a.data as Record<string, unknown>, false);
    }
    return next(p);
  });
}
