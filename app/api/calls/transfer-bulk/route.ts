import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { requestTransfers } from '@/lib/services/orders/calls';

export const dynamic = 'force-dynamic';

/** { ids, toUserId } — сонгосон бүртгэлүүдийг нэг дор шилжүүлэх хүсэлт */
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'orders', need: 'edit' });
    return json(await requestTransfers(ctx.actor, await req.json().catch(() => ({}))));
  } catch (e) { return errorResponse(e); }
}
