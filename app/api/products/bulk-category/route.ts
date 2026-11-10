import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { bulkAssignCategory } from '@/lib/services/products';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'products', need: 'edit' });
    const body = await req.json().catch(() => ({}));
    return json(await bulkAssignCategory(ctx.actor, body));
  } catch (e) { return errorResponse(e); }
}
