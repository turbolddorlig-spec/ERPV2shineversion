import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { productStockHistory } from '@/lib/services/stock/views';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const ctx = await requireApiUser(req, { page: 'warehouse' });
    const sp = req.nextUrl.searchParams;
    return json(await productStockHistory(ctx.actor, params.id, {
      variantId: Number(sp.get('variantId')) || undefined, warehouseId: Number(sp.get('warehouseId')) || undefined, type: sp.get('type') ?? undefined,
      from: sp.get('from') || undefined, to: sp.get('to') || undefined, page: Number(sp.get('page')) || 1,
    }));
  } catch (e) { return errorResponse(e); }
}
