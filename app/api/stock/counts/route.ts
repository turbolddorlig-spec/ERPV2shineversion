import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { listCounts, startCount } from '@/lib/services/stock/counts';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'warehouse' });
    const sp = req.nextUrl.searchParams;
    return json(await listCounts(ctx.actor, { status: sp.get('status') ?? undefined, page: Number(sp.get('page')) || 1 }));
  } catch (e) { return errorResponse(e); }
}
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'warehouse', need: 'edit' });
    return json({ count: await startCount(ctx.actor, await req.json().catch(() => ({}))) }, 201);
  } catch (e) { return errorResponse(e); }
}
