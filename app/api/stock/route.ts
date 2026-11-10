import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { stockList } from '@/lib/services/stock/views';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'warehouse' });
    const sp = req.nextUrl.searchParams;
    return json(await stockList(ctx.actor, {
      q: sp.get('q') ?? undefined, categoryId: Number(sp.get('categoryId')) || undefined, warehouseId: Number(sp.get('warehouseId')) || undefined,
      inStock: sp.get('inStock') === '1', ids: (sp.get('ids') ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0), sort: sp.get('sort') ?? undefined, page: Number(sp.get('page')) || 1,
    }));
  } catch (e) { return errorResponse(e); }
}
