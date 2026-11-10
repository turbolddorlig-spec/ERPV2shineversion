import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { getCount } from '@/lib/services/stock/counts';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const ctx = await requireApiUser(req, { page: 'warehouse' });
    return json({ count: await getCount(ctx.actor, params.id) });
  } catch (e) { return errorResponse(e); }
}
