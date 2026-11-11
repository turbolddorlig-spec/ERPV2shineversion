import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { notFound } from '@/lib/errors';
import { deliverOrder, driverCancel, postponeOrder, reportIssue, setRouteNo, undoDelivery, undoPostpone } from '@/lib/services/delivery/driver';

export const dynamic = 'force-dynamic';

/** deliver | undo-delivery | cancel | postpone | undo-postpone | issue | route — жолооч зөвхөн өөрийн захиалгад (сессээс) */
export async function POST(req: NextRequest, { params }: { params: { id: string; action: string } }) {
  try {
    const ctx = await requireApiUser(req, { page: 'driver', need: 'edit' });
    const body = await req.json().catch(() => ({}));
    switch (params.action) {
      case 'deliver': return json(await deliverOrder(ctx.actor, params.id, body));
      case 'undo-delivery': return json(await undoDelivery(ctx.actor, params.id, body));
      case 'cancel': return json(await driverCancel(ctx.actor, params.id, body));
      case 'postpone': return json(await postponeOrder(ctx.actor, params.id, body));
      case 'undo-postpone': return json(await undoPostpone(ctx.actor, params.id));
      case 'issue': return json(await reportIssue(ctx.actor, params.id, body));
      case 'route': return json(await setRouteNo(ctx.actor, params.id, body));
      default: throw notFound();
    }
  } catch (e) { return errorResponse(e); }
}
