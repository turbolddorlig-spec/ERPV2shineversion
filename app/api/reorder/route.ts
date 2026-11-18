import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { cancelReorder, markReordered, reorderBoard, reorderDetail } from '@/lib/services/outflow';

export const dynamic = 'force-dynamic';

/** #174 «Бараа татах» — бараа захиалгын ажилтан, Супер админ (мөнгөн дүнгүй) */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'reorder' });
    const sp = req.nextUrl.searchParams;
    if (sp.get('view') === 'detail') return json(await reorderDetail(ctx.actor, sp.get('id')));
    return json(await reorderBoard(ctx.actor, { tab: sp.get('tab') ?? undefined, q: sp.get('q') ?? undefined, page: Number(sp.get('page')) || 1 }));
  } catch (e) { return errorResponse(e); }
}
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'reorder', need: 'edit' });
    const b = await req.json().catch(() => ({}));
    if (b.action === 'reorder') return json(await markReordered(ctx.actor, b));
    if (b.action === 'reorder-cancel') return json(await cancelReorder(ctx.actor, b.id));
    return json({ error: 'Үйлдэл буруу' }, 400);
  } catch (e) { return errorResponse(e); }
}
