import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { refillList } from '@/lib/services/stock/views';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'warehouse' });
    return json(await refillList(ctx.actor));
  } catch (e) { return errorResponse(e); }
}
