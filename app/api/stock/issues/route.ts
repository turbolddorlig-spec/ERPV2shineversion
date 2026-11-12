import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { createIssue, listIssues, reviewIssues } from '@/lib/services/stock/docs';

export const dynamic = 'force-dynamic';

/** Аудит #143: зарлага хянах жагсаалт (Супер админ, Админ) */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'warehouse' });
    const sp = req.nextUrl.searchParams;
    return json(await listIssues(ctx.actor, { status: sp.get('status') ?? undefined, page: Number(sp.get('page')) || 1 }));
  } catch (e) { return errorResponse(e); }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'warehouse', need: 'edit' });
    const body = await req.json().catch(() => ({}));
    if (body?.action === 'review') return json(await reviewIssues(ctx.actor, body));
    const r = await createIssue(ctx.actor, body);
    return json(r, r.duplicate ? 200 : 201);
  } catch (e) { return errorResponse(e); }
}
