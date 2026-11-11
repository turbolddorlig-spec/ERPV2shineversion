import { db } from '../db';
import { badRequest, forbidden } from '../errors';
import { writeAudit } from '../audit';
import { dateOnly, ubDay } from '../ubdate';
import { addDays } from './delivery/core';
import { productStockTotals } from './stock/views';
import { computeReorder, createReorder, cancelReorderOf, getConfig, reorderDetailOf, unitsByDay, type ReorderInfo } from './outflow';
import { shopOf } from './supplier';
import type { UserActor } from './users';

/**
 * #122 Нийлүүлэгчийн «Миний барааны гарц» — зөвхөн өөрийн дэлгүүрт одоо оноогдсон бараа:
 *  • 7 хоногийн гарц — Барааны гарцын дүрмээр (захиалгын өдөр, төлбөр хүлээж буй / тэр өдөртөө цуцлагдсан орохгүй);
 *  • нөөц хоног ба «Захиалсан» — СА-ын «Бараа татах»-тай ижил (#119), агуулахад орлого ормогц дахин эхэлнэ;
 *  • авах мөнгө = борлуулалт − 1 ширхэгийн суутгал × ширхэг (захиалгаар тооцоолсон; бодит шилжүүлэг хүргэгдсэнээр, падааны өдрөөр);
 *  • өөрийн өртөг — зөвхөн нийлүүлэгч өөрөө бичиж, өөрөө харна → цэвэр ашиг.
 * Бүүст, $, пэйж, маркетинг, утас, эзний ашиг харагдахгүй. Үлдэгдэлд хүрэхгүй.
 */
async function ctx(actor: UserActor, shopIdIn: unknown) {
  const shop = await shopOf(actor, shopIdIn);
  const today = ubDay();
  const asg = await db.supplierProduct.findMany({ where: { shopId: shop.id, OR: [{ toDate: null }, { toDate: { gt: dateOnly(today) } }] }, select: { productId: true } });
  return { shop, today, ids: asg.map((a) => a.productId), isOwner: shop.userId === actor.id };
}

export async function supplierOutflow(actor: UserActor, shopIdIn: unknown) {
  const { shop, today, ids, isOwner } = await ctx(actor, shopIdIn);
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, -i));
  const cfg = await getConfig();
  if (!ids.length) return { shopId: shop.id, days, rows: [], isOwner, leadDays: cfg.leadDays, urgentDays: cfg.urgentDays, needs: 0 };
  const [products, aggs, stock, ded, costs, ro] = await Promise.all([
    db.product.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, name: true, price: true } }),
    unitsByDay(days[6]!, today, ids),
    productStockTotals(ids),
    db.supplierDeduction.findMany({ where: { shopId: shop.id, productId: { in: ids } } }),
    isOwner ? db.supplierOwnCost.findMany({ where: { shopId: shop.id, productId: { in: ids } } }) : Promise.resolve([]),
    computeReorder(),
  ]);
  const di = new Map(days.map((d, i) => [d, i]));
  const dm = new Map(ded.map((d) => [d.productId, d.operatorCost + d.deliveryCost + d.marketingCost + d.otherCost]));
  const cm = new Map(costs.map((c) => [c.productId, c.cost]));
  const rows = products.map((p) => {
    const daily = Array(7).fill(0) as number[]; let revenue = 0;
    for (const a of aggs) { if (a.productId !== p.id) continue; const i = di.get(a.day); if (i === undefined) continue; daily[i] += a.qty; revenue += a.revenue; }
    const week = daily.reduce((s, n) => s + n, 0);
    const perUnitDed = dm.get(p.id) ?? 0;
    const earn = revenue - week * perUnitDed;
    const cost = isOwner ? cm.get(p.id) ?? null : null;
    const r = ro.get(p.id);
    return {
      id: p.id, code: p.code, name: p.name, price: p.price, daily, week, avg: Math.round((week / 7) * 10) / 10,
      available: stock.get(p.id)?.available ?? 0,
      reorder: r ? { level: r.level, days: r.days, pace: r.pace, runOutDay: r.runOutDay, order: r.order ? { expectedDay: r.order.expectedDay, qty: r.order.qty } : null } as Pick<ReorderInfo, 'level' | 'days' | 'pace' | 'runOutDay'> & { order: { expectedDay: string; qty: number } | null } : null,
      money: { perUnitDed, perUnitEarn: p.price - perUnitDed, revenue, earn, cost, profit: cost === null ? null : earn - week * cost, perUnitProfit: cost === null ? null : p.price - perUnitDed - cost },
    };
  }).sort((a, b) => b.week - a.week || a.name.localeCompare(b.name));
  const needs = rows.filter((r) => r.reorder && ['ORDER', 'URGENT', 'LATE'].includes(r.reorder.level)).length;
  return { shopId: shop.id, days, rows, isOwner, leadDays: cfg.leadDays, urgentDays: cfg.urgentDays, needs };
}

const own = (ids: number[], productId: unknown) => { if (!ids.includes(Number(productId))) throw forbidden('Таны бараа биш'); };

export async function supplierReorderDetail(actor: UserActor, shopIdIn: unknown, productIdIn: unknown) {
  const { ids } = await ctx(actor, shopIdIn); own(ids, productIdIn);
  return reorderDetailOf(productIdIn);
}
export async function supplierReorder(actor: UserActor, shopIdIn: unknown, b: { productId?: unknown; qty?: unknown; expectedDay?: unknown; note?: unknown }) {
  const { ids } = await ctx(actor, shopIdIn); own(ids, b.productId);
  return createReorder(actor, b);
}
export async function supplierReorderCancel(actor: UserActor, shopIdIn: unknown, idIn: unknown) {
  const { ids } = await ctx(actor, shopIdIn);
  return cancelReorderOf(actor, idIn, new Set(ids));
}
/** Өөрийн өртөг — зөвхөн тэр нийлүүлэгч (Админ, Супер админ ч бичихгүй, харахгүй) */
export async function saveOwnCost(actor: UserActor, b: { productId?: unknown; cost?: unknown }) {
  if (!actor.roles.includes('SUPPLIER')) throw forbidden('Өөрийн өртгийг зөвхөн нийлүүлэгч өөрөө бичнэ');
  const { shop, ids, isOwner } = await ctx(actor, null);
  if (!isOwner) throw forbidden('Өөрийн өртгийг зөвхөн нийлүүлэгч өөрөө бичнэ');
  own(ids, b.productId);
  const productId = Number(b.productId);
  if (b.cost === '' || b.cost === null || b.cost === undefined) {
    await db.supplierOwnCost.deleteMany({ where: { shopId: shop.id, productId } });
  } else {
    const cost = Number(b.cost);
    if (!Number.isInteger(cost) || cost < 0 || cost > 100_000_000) throw badRequest('Өртөг буруу');
    await db.supplierOwnCost.upsert({ where: { shopId_productId: { shopId: shop.id, productId } }, create: { shopId: shop.id, productId, cost }, update: { cost } });
  }
  await writeAudit(actor, 'supplier.own-cost', 'SupplierOwnCost', `${shop.id}:${productId}`, { productId });
  return { ok: true };
}
/** Бүх хуудасны дээрх 🚚 сануулга — нийлүүлэгчид */
export async function supplierReorderBanner(actor: UserActor): Promise<{ urgent: number; order: number; late: number } | null> {
  if (!actor.roles.includes('SUPPLIER')) return null;
  const shop = await db.supplierShop.findUnique({ where: { userId: actor.id } });
  if (!shop?.isActive) return null;
  const today = ubDay();
  const asg = await db.supplierProduct.findMany({ where: { shopId: shop.id, OR: [{ toDate: null }, { toDate: { gt: dateOnly(today) } }] }, select: { productId: true } });
  const m = await computeReorder();
  let urgent = 0, order = 0, late = 0;
  for (const a of asg) { const x = m.get(a.productId); if (x?.level === 'URGENT') urgent++; else if (x?.level === 'ORDER') order++; else if (x?.level === 'LATE') late++; }
  return urgent || order || late ? { urgent, order, late } : null;
}
