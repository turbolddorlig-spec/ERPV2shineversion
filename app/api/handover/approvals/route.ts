import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { setApproval, setTrusted } from '@/lib/services/delivery/handover';

export const dynamic = 'force-dynamic';

/** { driverId, date, approved, note } — OKEY / ХОРИГ; { driverId, trusted } — итгэлтэй жолооч */
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'handover' });
    const body = await req.json().catch(() => ({}));
    if (body.trusted !== undefined) return json(await setTrusted(ctx.actor, body));
    return json(await setApproval(ctx.actor, body));
  } catch (e) { return errorResponse(e); }
}
