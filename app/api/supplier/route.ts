import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import * as S from '@/lib/services/supplier';
import { notFound } from '@/lib/errors';

export const dynamic = 'force-dynamic';

/** (хоосон) — самбар · ?shop=<id> (нийлүүлэгчид өөрийнх) · ?day=<ymd>&shop · ?from&to&shop — нэгтгэл · ?search=<q> */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'supplier' });
    const sp = req.nextUrl.searchParams;
    const shop = sp.get('shop');
    if (sp.get('day')) return json(await S.dayView(ctx.actor, shop, sp.get('day')));
    if (sp.get('from')) return json(await S.rangeSummary(ctx.actor, shop, sp.get('from'), sp.get('to')));
    if (sp.has('search')) return json(await S.searchProducts(ctx.actor, sp.get('search')));
    if (shop || sp.has('me')) return json(await S.shopDetail(ctx.actor, shop));
    return json(await S.overview(ctx.actor));
  } catch (e) { return errorResponse(e); }
}

/** { action: shop | active | assign | unassign | deduction | defaults | override | transfer | undo-transfer | login | login-reset, ... } */
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'supplier', need: 'edit' });
    const b = await req.json().catch(() => ({}));
    switch (b.action) {
      case 'shop': return json(await S.saveShop(ctx.actor, b));
      case 'active': return json(await S.setShopActive(ctx.actor, b.shopId, b.active));
      case 'assign': return json(await S.assignProduct(ctx.actor, b));
      case 'unassign': return json(await S.unassignProduct(ctx.actor, b.id));
      case 'deduction': return json(await S.saveDeduction(ctx.actor, b));
      case 'defaults': return json(await S.setDefaults(ctx.actor, b));
      case 'override': return json(await S.overrideDay(ctx.actor, b));
      case 'transfer': return json(await S.transferDay(ctx.actor, b));
      case 'undo-transfer': return json(await S.undoTransfer(ctx.actor, b));
      case 'login': return json(await S.createLogin(ctx.actor, b));
      case 'login-reset': return json(await S.resetLogin(ctx.actor, b));
      default: throw notFound();
    }
  } catch (e) { return errorResponse(e); }
}
