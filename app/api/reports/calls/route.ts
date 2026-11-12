import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { callAnalysis } from '@/lib/services/orders/reports';
import { withHeavy } from '@/lib/heavy';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'reports' });
    const sp = req.nextUrl.searchParams;
    return json(await withHeavy(() => callAnalysis(ctx.actor, { from: sp.get('from') || undefined, to: sp.get('to') || undefined, by: sp.get('by') || undefined, bucket: sp.get('bucket') || undefined })));
  } catch (e) { return errorResponse(e); }
}
