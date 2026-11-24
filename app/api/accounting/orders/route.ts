import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { findOrderForAccounting } from '@/lib/services/accounting/settle';

export const dynamic = 'force-dynamic';

/** #212: нягтлан захиалгын дугаараар хайх (хэзээний ч) */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'accounting' });
    return json(await findOrderForAccounting(ctx.actor, req.nextUrl.searchParams.get('number')));
  } catch (e) { return errorResponse(e); }
}
