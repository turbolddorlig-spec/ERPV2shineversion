import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { addBlacklist, listBlacklist } from '@/lib/services/orders/admin';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'orders' });
    const sp = req.nextUrl.searchParams;
    return json(await listBlacklist(ctx.actor, { q: sp.get('q') ?? undefined, page: Number(sp.get('page')) || 1 }));
  } catch (e) { return errorResponse(e); }
}
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'orders', need: 'edit' });
    return json({ entry: await addBlacklist(ctx.actor, await req.json().catch(() => ({}))) }, 201);
  } catch (e) { return errorResponse(e); }
}
