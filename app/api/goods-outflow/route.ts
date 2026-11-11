import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import * as S from '@/lib/services/outflow';
import { notFound } from '@/lib/errors';

export const dynamic = 'force-dynamic';

/** ?view = table | alerts | pages | pageboard | stats | work | my | eval | daily | history | profit | config | ids */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'goods-outflow' });
    const sp = req.nextUrl.searchParams;
    const g = (k: string) => sp.get(k) ?? undefined;
    const tp = { q: g('q'), tab: g('tab'), zone: g('zone'), owner: g('owner'), dollar: g('dollar'), status: g('status'), sort: g('sort'), dir: g('dir'), page: Number(g('page') ?? 1) };
    switch (g('view') ?? 'table') {
      case 'table': return json(await S.outflowTable(ctx.actor, tp));
      case 'ids': return json(await S.filteredIds(ctx.actor, tp));
      case 'alerts': return json(await S.alertsView(ctx.actor));
      case 'pages': return json(await S.productPages(ctx.actor, g('id')));
      case 'pageboard': return json(await S.pageBoard(ctx.actor));
      case 'stats': return json(await S.stats(ctx.actor, g('from'), g('to')));
      case 'work': return json(await S.workWindow(ctx.actor, { tab: g('tab'), q: g('q'), page: Number(g('page') ?? 1) }));
      case 'my': return json(await S.myWork(ctx.actor));
      case 'eval': return json(await S.evaluation(ctx.actor, g('date')));
      case 'daily': return json(await S.dailyDetail(ctx.actor, g('date')));
      case 'history': return json(await S.scoreHistory(ctx.actor, g('from'), g('to')));
      case 'profit': return json(await S.profitDetail(ctx.actor, g('id')));
      case 'config': return json(await S.configView(ctx.actor));
      default: throw notFound();
    }
  } catch (e) { return errorResponse(e); }
}

/** { action: boost | note | owner | watch | claim | release | page-owner | score | config, ... } */
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'goods-outflow', need: 'edit' });
    const b = await req.json().catch(() => ({}));
    switch (b.action) {
      case 'boost': return json(await S.saveBoost(ctx.actor, b));
      case 'note': return json(await S.saveNote(ctx.actor, b));
      case 'owner': return json(await S.setOwner(ctx.actor, b));
      case 'watch': return json(await S.watchProduct(ctx.actor, b.productId));
      case 'claim': return json(await S.claim(ctx.actor, b.productId));
      case 'release': return json(await S.release(ctx.actor, b.id));
      case 'page-owner': return json(await S.setPageOwner(ctx.actor, b));
      case 'score': return json(await S.saveScore(ctx.actor, b));
      case 'config': return json(await S.setConfig(ctx.actor, b));
      default: throw notFound();
    }
  } catch (e) { return errorResponse(e); }
}
