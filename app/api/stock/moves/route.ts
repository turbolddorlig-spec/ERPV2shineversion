import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { moveHistory } from '@/lib/services/stock/views';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'warehouse' });
    const sp = req.nextUrl.searchParams;
    return json(await moveHistory(ctx.actor, {
      variantId: Number(sp.get('variantId')) || undefined, productId: Number(sp.get('productId')) || undefined, warehouseId: Number(sp.get('warehouseId')) || undefined,
      type: sp.get('type') ?? undefined, from: sp.get('from') || undefined, to: sp.get('to') || undefined,
      docType: sp.get('docType') || undefined, docId: Number(sp.get('docId')) || undefined, page: Number(sp.get('page')) || 1,
    }));
  } catch (e) { return errorResponse(e); }
}
