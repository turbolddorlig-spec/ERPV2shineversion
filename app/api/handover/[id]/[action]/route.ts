import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { notFound } from '@/lib/errors';
import { confirmHandover, prepareHandover, revertHandover, setCheck } from '@/lib/services/delivery/handover';

export const dynamic = 'force-dynamic';

/** check | prepare | confirm | revert */
export async function POST(req: NextRequest, { params }: { params: { id: string; action: string } }) {
  try {
    const ctx = await requireApiUser(req, { page: 'handover', need: 'edit' });
    const body = await req.json().catch(() => ({}));
    switch (params.action) {
      case 'check': return json(await setCheck(ctx.actor, params.id, body));
      case 'prepare': return json({ handover: await prepareHandover(ctx.actor, params.id) });
      case 'confirm': return json({ handover: await confirmHandover(ctx.actor, params.id) });
      case 'revert': return json({ handover: await revertHandover(ctx.actor, params.id) });
      default: throw notFound();
    }
  } catch (e) { return errorResponse(e); }
}
