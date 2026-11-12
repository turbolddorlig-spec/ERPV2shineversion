import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { salaryBasisImpact, salaryRules, setSalaryBasis, setSalaryRules } from '@/lib/services/accounting/settle';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req);
    return json(await salaryRules(ctx.actor));
  } catch (e) { return errorResponse(e); }
}
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req);
    const body = await req.json().catch(() => ({}));
    // Цалин бодох арга (switch, #139): эхлээд нөлөөллийг харуулна, дараа нь «СОЛИХ» гэж бичиж баталгаажуулна
    if (body.action === 'basis-impact') return json(await salaryBasisImpact(ctx.actor, body));
    if (body.action === 'basis') return json(await setSalaryBasis(ctx.actor, body));
    return json(await setSalaryRules(ctx.actor, body));
  } catch (e) { return errorResponse(e); }
}
