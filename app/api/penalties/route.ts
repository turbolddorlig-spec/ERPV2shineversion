import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { createPenalty, employeeInfo, listPenalties } from '@/lib/services/penalties';

export const dynamic = 'force-dynamic';

/** ?from&to&type&userId&status&page — эсвэл ?employee=<userId> «Ажилчдын мэдээлэл» */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'penalties' });
    const sp = req.nextUrl.searchParams;
    if (sp.get('employee')) return json(await employeeInfo(ctx.actor, sp.get('employee')));
    return json(await listPenalties(ctx.actor, { from: sp.get('from') ?? undefined, to: sp.get('to') ?? undefined, type: sp.get('type') ?? undefined, userId: sp.get('userId') ?? undefined, status: sp.get('status') ?? undefined, page: Number(sp.get('page') ?? 1) }));
  } catch (e) { return errorResponse(e); }
}
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'penalties', need: 'edit' });
    return json(await createPenalty(ctx.actor, await req.json().catch(() => ({}))), 201);
  } catch (e) { return errorResponse(e); }
}
