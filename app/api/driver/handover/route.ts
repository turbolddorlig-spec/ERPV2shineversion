import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { myHandover } from '@/lib/services/delivery/handover';

export const dynamic = 'force-dynamic';

/** Жолоочийн падаан (өнөөдрийнх эсвэл хүлээн аваагүй үлдсэн) */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'driver', need: 'edit' });
    return json(await myHandover(ctx.actor));
  } catch (e) { return errorResponse(e); }
}
