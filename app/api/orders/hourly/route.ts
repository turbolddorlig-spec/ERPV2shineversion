import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { hourlyReport } from '@/lib/services/orders/queries';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'orders' });
    return json(await hourlyReport(ctx.actor, req.nextUrl.searchParams.get('date') ?? undefined));
  } catch (e) { return errorResponse(e); }
}
