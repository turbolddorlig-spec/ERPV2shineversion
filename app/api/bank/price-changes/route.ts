import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { priceChanges } from '@/lib/services/accounting/bank';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'bank-import' });
    return json(await priceChanges(ctx.actor, { page: Number(req.nextUrl.searchParams.get('page') ?? 1) }));
  } catch (e) { return errorResponse(e); }
}
