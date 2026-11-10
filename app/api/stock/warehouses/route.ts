import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { createWarehouse, listWarehouses } from '@/lib/services/stock/warehouses';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req);
    return json({ items: await listWarehouses(ctx.actor, { includeInactive: req.nextUrl.searchParams.get('all') === '1' }) });
  } catch (e) { return errorResponse(e); }
}
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'warehouse', need: 'edit' });
    return json({ warehouse: await createWarehouse(ctx.actor, await req.json().catch(() => ({}))) }, 201);
  } catch (e) { return errorResponse(e); }
}
