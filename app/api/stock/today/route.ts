import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { todayWork } from '@/lib/services/stock/views';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'warehouse' });
    return json(await todayWork(ctx.actor, { fresh: true }));
  } catch (e) { return errorResponse(e); }
}
