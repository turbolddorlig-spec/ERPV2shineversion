import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { nextProductCode } from '@/lib/services/products';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'products', need: 'edit' });
    return json({ code: await nextProductCode(ctx.actor) });
  } catch (e) { return errorResponse(e); }
}
