import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { deleteHandover, handoverDetail, shortages } from '@/lib/services/delivery/handover';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const ctx = await requireApiUser(req, { page: 'handover' });
    // Аудит #147: дэлгэрэнгүйг нэг л удаа тооцоолно
    const handover = await handoverDetail(ctx.actor, params.id);
    const short = await shortages(ctx.actor, params.id, handover);
    return json({ handover, shortages: short });
  } catch (e) { return errorResponse(e); }
}
/** «Падаан буцаах» — зөвхөн ноорог */
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const ctx = await requireApiUser(req, { page: 'handover', need: 'edit' });
    return json(await deleteHandover(ctx.actor, params.id));
  } catch (e) { return errorResponse(e); }
}
