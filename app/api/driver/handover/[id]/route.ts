import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { badRequest } from '@/lib/errors';
import { receiveHandover, setDriverCheck } from '@/lib/services/delivery/handover';

export const dynamic = 'force-dynamic';

/** { action: 'check', variantId | 'all', checked } — бараа чагтлах; { action: 'receive' } — «Барааг бүрэн хүлээн авсан» */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const ctx = await requireApiUser(req, { page: 'driver', need: 'edit' });
    const body = await req.json().catch(() => ({}));
    if (body.action === 'check') return json({ handover: await setDriverCheck(ctx.actor, params.id, body) });
    if (body.action === 'receive') return json({ handover: await receiveHandover(ctx.actor, params.id) });
    throw badRequest('Үйлдэл буруу');
  } catch (e) { return errorResponse(e); }
}
