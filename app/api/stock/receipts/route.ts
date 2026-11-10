import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { createReceipt } from '@/lib/services/stock/docs';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'warehouse', need: 'edit' });
    const r = await createReceipt(ctx.actor, await req.json().catch(() => ({})));
    return json(r, r.duplicate ? 200 : 201);
  } catch (e) { return errorResponse(e); }
}
