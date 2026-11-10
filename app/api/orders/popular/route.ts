import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { popularForPage } from '@/lib/services/orders/queries';
import { searchVariants } from '@/lib/services/products';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

/** Пэйжийн түгээмэл бараа (#50, туршилт) — хайлтын үр дүнгийн хэлбэрээр */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'orders' });
    const top = await popularForPage(ctx.actor, Number(req.nextUrl.searchParams.get('pageId')));
    if (!top.length) return json({ items: [] });
    const codes = await db.productVariant.findMany({ where: { id: { in: top.map((t) => t.variantId) } }, select: { id: true, code: true } });
    const items = [];
    for (const t of top) {
      const code = codes.find((c) => c.id === t.variantId)?.code;
      if (!code) continue;
      const hit = (await searchVariants(ctx.actor, code, 5)).find((h) => h.variantId === t.variantId);
      if (hit) items.push({ ...hit, soldQty: t.qty });
    }
    return json({ items });
  } catch (e) { return errorResponse(e); }
}
