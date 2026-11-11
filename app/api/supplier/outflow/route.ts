import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import * as S from '@/lib/services/supplier-outflow';
import { notFound } from '@/lib/errors';

export const dynamic = 'force-dynamic';

/** #122 Нийлүүлэгчийн «Миний барааны гарц»: ?shop=<id> (админ) | (нийлүүлэгчид өөрийнх) · &view=reorder&id=<productId> */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'supplier' });
    const sp = req.nextUrl.searchParams;
    const shop = sp.get('shop');
    if (sp.get('view') === 'reorder') return json(await S.supplierReorderDetail(ctx.actor, shop, sp.get('id')));
    return json(await S.supplierOutflow(ctx.actor, shop));
  } catch (e) { return errorResponse(e); }
}

/** { action: reorder | reorder-cancel | cost, shopId?, ... } — нийлүүлэгч өөрөө (харах эрхтэй ч өөрийн бараанд) */
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'supplier' });
    const b = await req.json().catch(() => ({}));
    switch (b.action) {
      case 'reorder': return json(await S.supplierReorder(ctx.actor, b.shopId ?? null, b));
      case 'reorder-cancel': return json(await S.supplierReorderCancel(ctx.actor, b.shopId ?? null, b.id));
      case 'cost': return json(await S.saveOwnCost(ctx.actor, b));
      default: throw notFound();
    }
  } catch (e) { return errorResponse(e); }
}
