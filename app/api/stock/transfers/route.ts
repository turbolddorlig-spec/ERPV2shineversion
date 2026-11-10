import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { listTransfers, sendTransfer } from '@/lib/services/stock/transfers';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'warehouse' });
    const sp = req.nextUrl.searchParams;
    return json(await listTransfers(ctx.actor, { status: sp.get('status') ?? undefined, warehouseId: Number(sp.get('warehouseId')) || undefined, incoming: sp.get('incoming') === '1', page: Number(sp.get('page')) || 1 }));
  } catch (e) { return errorResponse(e); }
}
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'warehouse', need: 'edit' });
    const r = await sendTransfer(ctx.actor, await req.json().catch(() => ({})));
    return json(r, r.duplicate ? 200 : 201);
  } catch (e) { return errorResponse(e); }
}
