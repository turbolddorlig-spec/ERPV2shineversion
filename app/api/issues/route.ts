import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { listIssues } from '@/lib/services/delivery/driver';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'issues' });
    const sp = req.nextUrl.searchParams;
    return json(await listIssues(ctx.actor, { status: sp.get('status') ?? undefined, page: Number(sp.get('page')) || 1 }));
  } catch (e) { return errorResponse(e); }
}
