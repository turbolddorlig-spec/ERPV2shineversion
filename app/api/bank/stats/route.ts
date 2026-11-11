import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { bankStats } from '@/lib/services/accounting/bank';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'bank-import' });
    const sp = req.nextUrl.searchParams;
    return json(await bankStats(ctx.actor, { from: sp.get('from') ?? undefined, to: sp.get('to') ?? undefined }));
  } catch (e) { return errorResponse(e); }
}
