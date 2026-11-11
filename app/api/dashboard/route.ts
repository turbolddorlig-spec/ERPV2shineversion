import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import * as S from '@/lib/services/dashboard';

export const dynamic = 'force-dynamic';

/** ?view=summary&range=day|week|month&date=YYYY-MM-DD · ?view=attention */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'dashboard' });
    const sp = req.nextUrl.searchParams;
    if (sp.get('view') === 'attention') return json(await S.attention(ctx.actor));
    return json(await S.summary(ctx.actor, sp.get('range') ?? undefined, sp.get('date') ?? undefined));
  } catch (e) { return errorResponse(e); }
}
