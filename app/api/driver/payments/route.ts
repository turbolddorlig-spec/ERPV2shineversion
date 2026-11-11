import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { createDriverPayment } from '@/lib/services/accounting/settle';

export const dynamic = 'force-dynamic';

/** Урьдчилгаа шилжүүлэх / нэмэлт барааны тооцоо { kind: ADVANCE|EXTRA, date, amount, note, idemKey } */
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'driver', need: 'edit' });
    return json(await createDriverPayment(ctx.actor, await req.json().catch(() => ({}))));
  } catch (e) { return errorResponse(e); }
}
