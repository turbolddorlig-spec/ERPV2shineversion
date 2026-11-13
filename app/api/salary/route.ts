import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import * as S from '@/lib/services/salary';
import { notFound } from '@/lib/errors';

export const dynamic = 'force-dynamic';

/** ?ym — самбар · ?prepare=<staffKey>&ym&half · ?config=<staffKey> · ?schedule=<ym> · ?debts=1[&staffKey] · ?history=<recordId> */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'salary' });
    const sp = req.nextUrl.searchParams;
    if (sp.get('prepare')) return json(await S.prepareSalary(ctx.actor, sp.get('prepare'), sp.get('ym'), sp.get('half')));
    if (sp.get('config')) return json(await S.getConfig(ctx.actor, sp.get('config')));
    if (sp.get('schedule')) return json(await S.workSchedule(ctx.actor, sp.get('schedule')));
    if (sp.get('debts')) return json(await S.listDebts(ctx.actor, sp.get('staffKey') ?? undefined));
    if (sp.get('history')) return json(await S.recordHistory(ctx.actor, sp.get('history')));
    return json(await S.salaryBoard(ctx.actor, sp.get('ym') ?? undefined));
  } catch (e) { return errorResponse(e); }
}
/** { action: save | config | workday | external | external-remove | debt | transferred | lock | unlock | lock-code, ... } */
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'salary', need: 'edit' });
    const b = await req.json().catch(() => ({}));
    switch (b.action) {
      case 'save': return json(await S.saveSalary(ctx.actor, b));
      case 'config': return json(await S.setConfig(ctx.actor, b));
      case 'workday': return json(await S.setWorkDay(ctx.actor, b));
      case 'external': return json(await S.addExternal(ctx.actor, b));
      case 'external-remove': return json(await S.removeExternal(ctx.actor, b.id));
      case 'debt': return json(await S.addDebt(ctx.actor, b));
      case 'transferred': return json(await S.setTransferred(ctx.actor, b.id, b.value));
      case 'lock': return json(await S.lockSalary(ctx.actor, b.id, b.version));
      case 'unlock': return json(await S.unlockSalary(ctx.actor, b.id, b));
      case 'lock-code': return json(await S.setLockCode(ctx.actor, b));
      default: throw notFound();
    }
  } catch (e) { return errorResponse(e); }
}
