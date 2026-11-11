import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { resolveIssue } from '@/lib/services/delivery/driver';

export const dynamic = 'force-dynamic';

/** { action: 'fix' | 'cancel', note, fault? } — ахлах оператор, админ */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const ctx = await requireApiUser(req, { page: 'issues', need: 'edit' });
    return json(await resolveIssue(ctx.actor, params.id, await req.json().catch(() => ({}))));
  } catch (e) { return errorResponse(e); }
}
