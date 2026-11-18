import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { returnOrderLines } from '@/lib/services/accounting/settle';

export const dynamic = 'force-dynamic';

/** #172-1: хүргэсэн захиалгаас бараа хасах (нягтлан) → жолоочид өр */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const ctx = await requireApiUser(req, { page: 'accounting', need: 'edit' });
    return json(await returnOrderLines(ctx.actor, params.id, await req.json().catch(() => ({}))));
  } catch (e) { return errorResponse(e); }
}
