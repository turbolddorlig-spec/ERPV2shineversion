import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { myPenalties } from '@/lib/services/penalties';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'my-penalties' });
    const sp = req.nextUrl.searchParams;
    return json(await myPenalties(ctx.actor, { from: sp.get('from') ?? undefined, to: sp.get('to') ?? undefined, status: sp.get('status') ?? undefined, page: Number(sp.get('page') ?? 1) }));
  } catch (e) { return errorResponse(e); }
}
