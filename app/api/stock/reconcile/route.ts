import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { reconcile } from '@/lib/services/stock/views';
import { withHeavy } from '@/lib/heavy';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'warehouse' });
    const fresh = req.nextUrl.searchParams.get('fresh') === '1';
    // Аудит #141: шинээр тулгах нь хүнд — зэрэг тоо хязгаартай (санах ойн хуулбар бол шууд)
    return json(fresh ? await withHeavy(() => reconcile(ctx.actor, { fresh })) : await reconcile(ctx.actor, { fresh }));
  } catch (e) { return errorResponse(e); }
}
