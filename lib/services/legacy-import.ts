import { createHash } from 'node:crypto';
import type { Role } from '@prisma/client';
import { db } from '../db';
import { badRequest, conflict, forbidden } from '../errors';
import { writeAudit } from '../audit';
import { UB, UB_DISTRICTS, RURAL } from '../geo';
import { normalizePhone, isValidPhone } from '../phone';
import { cleanProductCode } from '../catalog/variants';
import { ubDay, dateOnly } from '../ubdate';
import { availableFor, findActiveDuplicate, activeBlacklist } from './orders/core';
import { primaryWarehouse } from './delivery/core';
import type { UserActor } from './users';

/**
 * Туршилтын оруулалт (эзний шийдвэр #138): хуучин ERP-ийн жолоочийн захиалгын жагсаалтыг (хуулж наасан текст) уншаад
 * V2-ийн ЖИНХЭНЭ урсгалаар нэг товчоор оруулна: бараа (+ «Орлого» баримт) → жолооч → захиалга → хуваарилалт → падаан →
 * жолооч хүлээн авах → Хүргэсэн / Цуцалсан / Маргааш. Бүх алхам ердийн функцээр явна (үлдэгдэл журналаар, B2).
 * Зөвхөн Супер админ. Хуучин дугаараар (legacy-<дугаар>) давтан оруулахад давхардахгүй, тасарсан бол үргэлжлүүлнэ.
 */

export type LegacyAction = 'DELIVER' | 'CANCEL' | 'POSTPONE';
export interface LegacyLine { code: string; name: string; qty: number; price: number }
export interface LegacyOrder {
  number: string; created: string; opp: string; phone: string; addressRaw: string; note: string | null;
  lines: LegacyLine[]; statusText: string; paymentText: string; amount: number;
  tomorrow: boolean; notReturned: boolean; action: LegacyAction | null; payment: 'CASH' | 'BANK' | null;
  errors: string[];
}

const NUM_RE = /^\d{6,10}$/;
const HEAD_RE = /^(\d{1,2}\/\d{1,2}\/\d{4})\t([^\t]*)\t([^\t]*)/;
const CODE_RE = /^\[([^\]]+)\]\s*(.*)$/;
const QTY_RE = /^(\d+)\s*ш\s*[×x*]\s*([\d,.\s]+)₮/;
const money = (s: string) => Number(String(s).replace(/[^\d]/g, '')) || 0;

function statusOf(s: string): { action: LegacyAction | null; ok: boolean } {
  const t = s.trim().toLowerCase();
  if (t === 'хүргэсэн' || t === 'хүргэгдсэн') return { action: 'DELIVER', ok: true };
  if (t.includes('цуцалсан') || t.includes('цуцласан') || t.includes('цуцлагдсан')) return { action: 'CANCEL', ok: true };
  return { action: null, ok: false };
}
function paymentOf(s: string): 'CASH' | 'BANK' | null | 'bad' {
  const t = s.trim().toLowerCase();
  if (!t || t === '-') return null;
  if (t.includes('жолоочид') || t.includes('бэлэн')) return 'CASH';
  if (t.includes('данс') || t.includes('банк') || t.includes('шилжүүл')) return 'BANK';
  return 'bad';
}

/** Хуучин ERP-ийн «Жолоочийн захиалга» хуудаснаас хуулсан текстийг уншина (мөр бүр нэг талбар, баганууд таб-аар) */
export function parseLegacy(text: string): { orders: LegacyOrder[]; declared: number | null } {
  const raw = String(text ?? '').replace(/\r/g, '').split('\n').map((l) => l.replace(/ /g, ' ').trimEnd());
  const declaredM = raw.slice(0, 3).join('\n').match(/(\d+)\s*захиалга/);
  const blocks: string[][] = [];
  for (const l of raw) {
    if (NUM_RE.test(l.trim())) blocks.push([l.trim()]);
    else if (blocks.length) blocks[blocks.length - 1]!.push(l);
  }
  const orders = blocks.map((b): LegacyOrder => {
    const o: LegacyOrder = { number: b[0]!, created: '', opp: '', phone: '', addressRaw: '', note: null, lines: [], statusText: '', paymentText: '', amount: 0, tomorrow: false, notReturned: false, action: null, payment: null, errors: [] };
    const rest = b.slice(1).filter((l) => l.trim() !== '');
    let i = 0;
    for (; i < rest.length; i++) {
      const l = rest[i]!.trim();
      if (HEAD_RE.test(rest[i]!)) break;
      if (l === 'Маргааш') o.tomorrow = true;
      else if (l.includes('буцаагаагүй')) o.notReturned = true;
    }
    const h = rest[i] ? HEAD_RE.exec(rest[i]!) : null;
    if (!h) { o.errors.push('Огноо / OPP / утасны мөр олдсонгүй'); return o; }
    o.created = h[1]!; o.opp = h[2]!.trim(); o.phone = normalizePhone(h[3]!);
    // Хаяг, санамж: толгойн дараагаас эхний «[КОД]» мөрийн өмнөх мөр (барааны нэр) хүртэл
    const body = rest.slice(i + 1);
    const firstCode = body.findIndex((l) => CODE_RE.test(l.trim()));
    if (firstCode < 1) { o.errors.push('Барааны «[КОД] нэр» мөр олдсонгүй'); return o; }
    const addr: string[] = []; const notes: string[] = [];
    for (const l of body.slice(0, firstCode - 1)) {
      const t = l.trim();
      const m = /^санамж\s*:\s*(.*)$/i.exec(t);
      if (m) { if (m[1]!.trim()) notes.push(m[1]!.trim()); } else addr.push(t);
    }
    o.addressRaw = addr.join(' ').replace(/\s+/g, ' ').trim();
    o.note = notes.join('; ') || null;
    let j = firstCode;
    while (j < body.length) {
      const cm = CODE_RE.exec(body[j]!.trim());
      if (!cm) break;
      const qm = QTY_RE.exec((body[j + 1] ?? '').trim());
      if (!qm) { o.errors.push(`«${cm[1]}» барааны «Nш × үнэ₮» мөр олдсонгүй`); return o; }
      o.lines.push({ code: cm[1]!.trim(), name: cm[2]!.trim() || cm[1]!.trim(), qty: Number(qm[1]), price: money(qm[2]!) });
      j += 2;
      // дараагийн бараа: «нэр» мөр + «[КОД]» мөр
      if (j + 1 < body.length && CODE_RE.test(body[j + 1]!.trim()) && !body[j]!.includes('\t')) j += 1;
    }
    const st = body.slice(j).find((l) => l.includes('\t') && statusOf(l.split('\t')[0]!).ok) ?? body.slice(j).find((l) => l.includes('\t'));
    if (!st) { o.errors.push('Төлөв / төлбөр / дүнгийн мөр олдсонгүй'); return o; }
    const cols = st.split('\t').map((c) => c.trim());
    o.statusText = cols[0] ?? ''; o.paymentText = cols[1] ?? ''; o.amount = money(cols[2] ?? '');
    const s = statusOf(o.statusText);
    if (!s.ok) o.errors.push(`Танихгүй төлөв «${o.statusText}»`);
    o.action = s.action;
    if (o.action === 'CANCEL' && o.tomorrow) o.action = 'POSTPONE';
    const p = paymentOf(o.paymentText);
    if (p === 'bad') o.errors.push(`Танихгүй төлбөр «${o.paymentText}»`);
    else o.payment = p;
    if (o.action === 'DELIVER' && !o.payment) o.errors.push('Хүргэсэн захиалгын төлбөр («Жолоочид төлсөн» / «Данс») алга');
    return o;
  });
  return { orders, declared: declaredM ? Number(declaredM[1]) : null };
}

/** «Баянгол, 6 бичил ...» → дүүрэг + дэлгэрэнгүй */
export function legacyAddress(raw: string): { province: string; district: string | null; addressDetail: string } | null {
  const idx = raw.indexOf(',');
  const head = (idx >= 0 ? raw.slice(0, idx) : raw).trim();
  const rest = (idx >= 0 ? raw.slice(idx + 1) : '').trim();
  const d = Object.keys(UB_DISTRICTS).find((k) => k.toLowerCase() === head.toLowerCase());
  if (d) return { province: UB, district: d, addressDetail: rest };
  if (RURAL.some((r) => r.toLowerCase() === head.toLowerCase())) return null; // орон нутаг — урьдчилгаатай, одоохондоо дэмжихгүй
  return null;
}

function assertSA(actor: UserActor) {
  if (!actor.roles.includes('SUPER_ADMIN')) throw forbidden('Туршилтын оруулалтыг зөвхөн Супер админ хийнэ');
}
const normName = (s: string) => s.toLowerCase().replace(/[-\s]*опп$/i, '').replace(/\s+/g, ' ').trim();

export interface PreviewInput { text?: unknown; driverName?: unknown; driverPhone?: unknown }

export async function legacyPreview(actor: UserActor, input: PreviewInput) {
  assertSA(actor);
  const text = String(input.text ?? '');
  if (text.length > 2_000_000) throw badRequest('Текст хэт урт');
  const driverName = String(input.driverName ?? '').trim().replace(/\s+/g, ' ');
  const driverPhone = normalizePhone(String(input.driverPhone ?? ''));
  const { orders, declared } = parseLegacy(text);
  const general: string[] = [];
  if (!orders.length) general.push('Захиалга олдсонгүй — хуучин ERP-ийн жагсаалтыг бүтнээр нь хуулж наана уу');
  if (declared !== null && declared !== orders.length) general.push(`Толгойд ${declared} захиалга гэсэн боловч ${orders.length} уншигдлаа — хуулбар дутуу эсэхийг шалгана уу`);
  if (driverName.length < 2) general.push('Жолоочийн нэрийг бичнэ үү');
  if (!isValidPhone(driverPhone)) general.push('Жолоочийн утас буруу (8 оронтой)');

  const today = ubDay();
  // Жолооч
  let driver: { id: string; name: string; isNew: boolean; roles: Role[] } | null = null;
  if (isValidPhone(driverPhone)) {
    const u = await db.user.findUnique({ where: { phone: driverPhone }, select: { id: true, name: true, roles: true, isActive: true } });
    if (u && !u.roles.includes('DRIVER')) general.push(`${driverPhone} утастай хэрэглэгч (${u.name}) жолооч биш`);
    else if (u && !u.isActive) general.push(`${u.name} идэвхгүй хэрэглэгч — эхлээд идэвхжүүлнэ үү`);
    else if (u) driver = { id: u.id, name: u.name, isNew: false, roles: u.roles };
    else driver = { id: '', name: driverName, isNew: true, roles: ['DRIVER'] };
  }

  // Аудит #155 (B2): аль хэдийн оруулсан захиалгын барааг дахин «орлого» хийхгүй — хэрэгцээ зөвхөн ШИНЭ захиалгаас
  const already = new Set((orders.length ? await db.order.findMany({ where: { idemKey: { in: orders.map((o) => `legacy-${o.number}`) } }, select: { idemKey: true } }) : []).map((e) => e.idemKey));
  const newOrders = orders.filter((o) => !already.has(`legacy-${o.number}`));
  // Бараа (кодоор)
  const codes = [...new Set(orders.flatMap((o) => o.lines.map((l) => cleanProductCode(l.code) ?? '')).filter(Boolean))];
  const prods = codes.length ? await db.product.findMany({ where: { code: { in: codes } }, include: { variants: true } }) : [];
  const pmap = new Map(prods.map((p) => [p.code, p]));
  const products = codes.map((code) => {
    const p = pmap.get(code);
    const ls = orders.flatMap((o) => o.lines.filter((l) => cleanProductCode(l.code) === code));
    const need = newOrders.flatMap((o) => o.lines.filter((l) => cleanProductCode(l.code) === code)).reduce((a, l) => a + l.qty, 0);
    const price = Math.max(...ls.map((l) => l.price));
    const v = p && p.variants.length === 1 ? p.variants[0]! : null;
    const errors: string[] = [];
    if (p && p.variants.length !== 1) errors.push(`V2-д «${code}» ${p.variants.length} хувилбартай — аль хувилбар болохыг тодорхойлох боломжгүй`);
    if (p && p.status === 'ARCHIVED') errors.push(`«${code}» архивласан бараа`);
    if (v && !v.isActive) errors.push(`«${code}» хувилбар идэвхгүй`);
    const listPrice = p ? (v?.priceOverride ?? p.price) : price;
    if (p && ls.some((l) => l.price > listPrice)) errors.push(`«${code}» V2-ийн үнэ ${listPrice}₮ — хуучин ERP-ийн үнээс бага (үнэ нэмэх боломжгүй)`);
    return { code, name: p?.name ?? ls[0]!.name, isNew: !p, variantId: v?.id ?? null, listPrice, need, errors };
  });
  const vIds = products.map((p) => p.variantId).filter((x): x is number => x !== null);
  const avail = vIds.length ? await availableFor(db, vIds) : new Map<number, number>();
  let primary: { locationId: number; name: string } | null = null;
  try { const w = await primaryWarehouse(db); primary = { locationId: w.locationId, name: w.warehouse.name }; } catch { general.push('Үндсэн агуулах тохируулаагүй байна'); }
  const pbal = primary && vIds.length ? await db.stockBalance.findMany({ where: { locationId: primary.locationId, variantId: { in: vIds } } }) : [];
  const pb = new Map(pbal.map((b) => [b.variantId, b.qty]));
  const productsOut = products.map((p) => {
    const have = p.variantId ? Math.max(0, Math.min(avail.get(p.variantId) ?? 0, pb.get(p.variantId) ?? 0)) : 0;
    return { ...p, have, receipt: Math.max(0, p.need - have) };
  });

  // OPP → V2 оператор (нэрээр санал)
  const ops = await db.user.findMany({ where: { isActive: true, roles: { hasSome: ['OPERATOR', 'OPERATOR_LEAD', 'SUPER_ADMIN', 'ADMIN'] } }, select: { id: true, name: true, roles: true }, orderBy: { name: 'asc' } });
  const oppNames = [...new Set(orders.map((o) => o.opp).filter(Boolean))];
  const opps = oppNames.map((name) => {
    const m = ops.find((u) => normName(u.name) === normName(name) && (u.roles.includes('OPERATOR') || u.roles.includes('OPERATOR_LEAD')));
    return { name, count: orders.filter((o) => o.opp === name).length, suggestId: m?.id ?? '' };
  });

  // Аль хэдийн орсон (legacy-<дугаар>), идэвхтэй давхар, хар жагсаалт
  const existing = orders.length ? await db.order.findMany({ where: { idemKey: { in: orders.map((o) => `legacy-${o.number}`) } }, select: { idemKey: true, number: true, status: true, driverId: true } }) : [];
  const emap = new Map(existing.map((e) => [e.idemKey, e]));
  // Өмнө нь аль жолоочид орсон (маргааш болгосон захиалга жолоочгүй болдог тул падааны түүхээр)
  const exIds = await db.order.findMany({ where: { idemKey: { in: existing.map((e) => e.idemKey!) } }, select: { id: true, idemKey: true } });
  const hos = exIds.length ? await db.handoverOrder.findMany({ where: { orderId: { in: exIds.map((x) => x.id) } }, select: { orderId: true, handover: { select: { driverId: true } } } }) : [];
  const ownerOf = new Map<string, string>();
  for (const x of exIds) {
    const e = emap.get(x.idemKey!);
    const d = e?.driverId ?? hos.find((h) => h.orderId === x.id)?.handover.driverId;
    if (d) ownerOf.set(x.idemKey!, d);
  }
  const rows = [];
  for (const o of orders) {
    const errors = [...o.errors];
    const warnings: string[] = [];
    const ex = emap.get(`legacy-${o.number}`);
    const addr = o.addressRaw ? legacyAddress(o.addressRaw) : null;
    if (!ex) {
      if (!isValidPhone(o.phone)) errors.push(`Утас буруу «${o.phone}»`);
      if (!addr) errors.push(`Хаягийн эхэнд УБ-ын дүүрэг алга «${o.addressRaw.slice(0, 40)}» (орон нутгийн захиалга одоохондоо оруулахгүй)`);
      else if (addr.addressDetail.length < 2) errors.push('Дэлгэрэнгүй хаяг хоосон');
      const sum = o.lines.reduce((a, l) => a + l.qty * l.price, 0);
      if (o.lines.length && o.amount && o.amount < sum) errors.push(`Дүн ${o.amount}₮ нь барааны нийлбэр ${sum}₮-өөс бага`);
      if (o.lines.length && o.amount > sum) warnings.push(`Хүргэлтийн төлбөр ${o.amount - sum}₮ нэмэгдэнэ`);
      if (isValidPhone(o.phone)) {
        const dup = await findActiveDuplicate(db, [o.phone]);
        if (dup) errors.push(`Энэ утсаар V2-д идэвхтэй захиалга №${dup.number} байна`);
        if ((await activeBlacklist(db, [o.phone])).length) warnings.push('Хар жагсаалтад байгаа утас (тэмдэглэлтэй орно)');
      }
      if (orders.filter((x) => x.phone === o.phone).length > 1) errors.push('Энэ жагсаалтад ижил утастай 2 захиалга байна (V2 нэг утсанд нэг идэвхтэй захиалга)');
    } else if (driver) {
      const owner = ownerOf.get(`legacy-${o.number}`);
      if (driver.isNew || (owner && owner !== driver.id)) errors.push(`Өмнө нь өөр жолоочид оруулсан (V2 №${ex.number})`);
    }
    for (const l of o.lines) {
      const p = productsOut.find((x) => x.code === cleanProductCode(l.code));
      if (!cleanProductCode(l.code)) errors.push(`Барааны код буруу «${l.code}»`);
      if (p?.errors.length) errors.push(...p.errors);
    }
    rows.push({
      number: o.number, opp: o.opp, phone: o.phone, address: o.addressRaw, note: o.note, district: addr?.district ?? null,
      lines: o.lines, amount: o.amount, statusText: o.statusText, paymentText: o.paymentText, tomorrow: o.tomorrow, notReturned: o.notReturned,
      action: o.action, payment: o.payment, existing: ex ? { number: ex.number, status: ex.status } : null,
      errors: [...new Set(errors)], warnings,
    });
  }
  // Жолоочийн өнөөдрийн байдал
  if (driver && !driver.isNew) {
    const h = await db.handover.findUnique({ where: { driverId_date: { driverId: driver.id, date: dateOnly(today) } }, select: { number: true, status: true } });
    const own = await db.order.count({ where: { driverId: driver.id, deliveryDate: dateOnly(today), status: { in: ['ASSIGNED', 'OUT_FOR_DELIVERY'] }, NOT: { idemKey: { startsWith: 'legacy-' } } } });
    if (own) general.push(`${driver.name}-д өнөөдөр V2-ээр оноосон өөр ${own} захиалга байна — өөр жолооч сонгоно уу`);
    if (h && h.status !== 'RECEIVED' && !rows.some((r) => r.existing)) general.push(`${driver.name}-д өнөөдрийн падаан ${h.number} аль хэдийн байна`);
    if (h && h.status === 'RECEIVED' && rows.some((r) => !r.existing)) general.push(`${driver.name} өнөөдрийн падаанаа (${h.number}) хүлээн авсан — шинэ захиалга нэмэх боломжгүй, өөр жолооч сонгоно уу`);
  }
  const fresh = rows.filter((r) => !r.existing);
  const deliver = rows.filter((r) => r.action === 'DELIVER');
  const summary = {
    total: rows.length, new: fresh.length, existing: rows.length - fresh.length,
    deliver: deliver.length, deliverSum: deliver.reduce((a, r) => a + r.amount, 0),
    cash: deliver.filter((r) => r.payment === 'CASH').reduce((a, r) => a + r.amount, 0),
    bank: deliver.filter((r) => r.payment === 'BANK').reduce((a, r) => a + r.amount, 0),
    cancel: rows.filter((r) => r.action === 'CANCEL').length, cancelSum: rows.filter((r) => r.action === 'CANCEL').reduce((a, r) => a + r.amount, 0),
    postpone: rows.filter((r) => r.action === 'POSTPONE').length, postponeSum: rows.filter((r) => r.action === 'POSTPONE').reduce((a, r) => a + r.amount, 0),
    salary: 0, rate: 0, rateLabel: '',
  };
  {
    // Цалингийн урьдчилсан тооцоо: тухайн өдрийн дүрэм + жолоочийн горимоор (switch, #139)
    const C = await import('./accounting/calc');
    const rules = await C.rulesFor(db, today);
    const mode = driver && !driver.isNew ? (await C.modesFor(db, [driver.id], today)).get(driver.id) : undefined;
    const countable = summary.deliver + summary.cancel + summary.postpone;
    const { rate, tier } = C.rateFor(rules, mode ?? { mode: 'NORMAL', regionalRate: null }, countable ? (summary.deliver / countable) * 100 : 0, countable, false);
    summary.rate = rate; summary.salary = rate * summary.deliver;
    summary.rateLabel = tier === 'flat' ? '1 хүргэлт тогтмол' : tier === 'regional' ? 'Орон нутаг' : 'Гүйцэтгэлээр';
  }
  const errorCount = general.length + rows.filter((r) => r.errors.length).length;
  return {
    ok: errorCount === 0, general, rows, summary, driver: driver ? { name: driver.isNew ? driverName : driver.name, phone: driverPhone, isNew: driver.isNew } : null,
    products: productsOut, opps, operators: ops.map((u) => ({ id: u.id, name: u.name })), warehouse: primary?.name ?? null, today,
  };
}

let running = false;
export interface CommitInput extends PreviewInput { oppMap?: unknown }

/** «Батлах»: урьдчилан харсантай яг ижил шалгалт → алдаагүй бол алхам алхмаар жинхэнэ функцээр */
export async function legacyCommit(actor: UserActor, input: CommitInput) {
  assertSA(actor);
  const pv = await legacyPreview(actor, input);
  if (!pv.ok) throw badRequest('Алдаатай мөр байна — «Шалгах» дарж засна уу', 'has_errors');
  if (!pv.driver) throw badRequest('Жолооч буруу');
  if (running) throw conflict('Өөр оруулалт явагдаж байна — түр хүлээнэ үү', 'busy');
  running = true;
  const steps: string[] = [];
  let tempPassword: string | null = null;
  try {
    const U = await import('./users');
    const P = await import('./products');
    const D = await import('./stock/docs');
    const O = await import('./orders/orders');
    const L = await import('./delivery/assign');
    const H = await import('./delivery/handover');
    const DR = await import('./delivery/driver');
    const C = await import('./accounting/calc');
    const today = ubDay();
    const ip = actor.ip;

    // 1. Жолооч
    let drvUser = await db.user.findUnique({ where: { phone: pv.driver.phone }, select: { id: true, name: true, roles: true } });
    if (!drvUser) {
      const r = await U.createUser(actor, { phone: pv.driver.phone, name: pv.driver.name, roles: ['DRIVER'] });
      tempPassword = r.temporaryPassword;
      drvUser = { id: r.user.id, name: r.user.name, roles: r.user.roles as Role[] };
      steps.push(`Шинэ жолооч үүслээ: ${drvUser.name} (${pv.driver.phone})`);
    }
    const drv: UserActor = { id: drvUser.id, name: drvUser.name, roles: drvUser.roles, ip };
    await H.setApproval(actor, { driverId: drv.id, date: today, approved: true, note: 'Туршилтын оруулалт' });

    // 2. Бараа + «Орлого»
    const vmap = new Map<string, number>();
    for (const p of pv.products) {
      if (p.variantId) { vmap.set(p.code, p.variantId); continue; }
      const created = await P.createProduct(actor, { code: p.code, name: p.name, price: p.listPrice });
      vmap.set(p.code, created.variants[0]!.id);
      steps.push(`Бараа үүслээ: [${p.code}] ${p.name} · ${p.listPrice.toLocaleString('mn-MN')}₮`);
    }
    const recLines = pv.products.filter((p) => p.receipt > 0).map((p) => ({ variantId: vmap.get(p.code)!, qty: p.receipt }));
    if (recLines.length) {
      const w = await primaryWarehouse(db);
      await D.createReceipt(actor, { warehouseId: w.warehouse.id, lines: recLines, note: `Туршилтын оруулалт: ${drv.name}`, idemKey: `legacy-rcpt-${createHash('sha256').update(`${drv.id}|${pv.today}|${recLines.map((l) => `${l.variantId}:${l.qty}`).join(',')}|${pv.rows.filter((r) => !r.existing).map((r) => r.number).sort().join(',')}`).digest('hex').slice(0, 40)}` });
      steps.push(`«Орлого» ${w.warehouse.name}: ${recLines.length} бараа, ${recLines.reduce((a, l) => a + l.qty, 0)} ширхэг`);
    }

    // 3. Захиалга (OPP → оператор)
    const map = (input.oppMap && typeof input.oppMap === 'object' ? input.oppMap : {}) as Record<string, unknown>;
    const opUsers = new Map<string, UserActor>();
    for (const o of pv.opps) {
      const id = String(map[o.name] ?? o.suggestId ?? '');
      const u = id ? await db.user.findFirst({ where: { id, isActive: true }, select: { id: true, name: true, roles: true } }) : null;
      opUsers.set(o.name, u && (u.roles.includes('OPERATOR') || u.roles.includes('OPERATOR_LEAD') || u.roles.includes('SUPER_ADMIN') || u.roles.includes('ADMIN')) ? { id: u.id, name: u.name, roles: u.roles, ip } : actor);
    }
    const ids = new Map<string, number>();
    let createdN = 0;
    for (const r of pv.rows) {
      if (r.existing) { const e = await db.order.findUniqueOrThrow({ where: { idemKey: `legacy-${r.number}` }, select: { id: true } }); ids.set(r.number, e.id); continue; }
      const addr = legacyAddress(r.address)!;
      const op = opUsers.get(r.opp) ?? actor;
      const lines = r.lines.map((l) => {
        const code = cleanProductCode(l.code)!;
        const p = pv.products.find((x) => x.code === code)!;
        return { variantId: vmap.get(code)!, qty: l.qty, ...(l.price < p.listPrice ? { unitPrice: l.price, discountReason: 'Хуучин ERP-ийн үнэ' } : {}) };
      });
      const sum = r.lines.reduce((a, l) => a + l.qty * l.price, 0);
      const fee = r.amount > sum ? r.amount - sum : undefined;
      const note = [r.note, `Хуучин №${r.number}`, op === actor && r.opp ? `OPP: ${r.opp}` : null].filter(Boolean).join(' · ');
      const res = await O.createOrder(op, {
        phone: r.phone, province: addr.province, district: addr.district, addressDetail: addr.addressDetail, note, deliveryDate: today,
        lines, idemKey: `legacy-${r.number}`, blacklistNote: r.warnings.some((w) => w.includes('Хар')) ? 'Хуучин ERP-ээс туршилтын оруулалт' : undefined,
        ...(fee !== undefined ? { deliveryFee: fee, feeReason: 'Хуучин ERP-ийн хүргэлтийн төлбөр' } : {}),
      });
      ids.set(r.number, res.order.id);
      createdN++;
    }
    if (createdN) steps.push(`${createdN} захиалга үүслээ`);

    // 4. Хуваарилалт (маргааш болгосныг дахин хуваарилахгүй)
    const all = [...ids.values()];
    const toAssign = (await db.order.findMany({ where: { id: { in: all }, status: 'NEW', driverId: null, postponedAt: null }, select: { id: true } })).map((o) => o.id);
    if (toAssign.length) { await L.assignOrders(actor, { ids: toAssign, driverId: drv.id }); steps.push(`${toAssign.length} захиалга ${drv.name}-д хуваарилагдлаа`); }

    // 5. Падаан → бэлтгэсэн → чагт → өгсөн → жолооч хүлээн авсан
    let h = await db.handover.findUnique({ where: { driverId_date: { driverId: drv.id, date: dateOnly(today) } } });
    const pendingAssigned = (await db.order.findMany({ where: { driverId: drv.id, deliveryDate: dateOnly(today), status: 'ASSIGNED', handoverId: null }, select: { id: true } })).map((o) => o.id);
    if (!h && pendingAssigned.length) {
      const d = await H.createHandover(actor, { driverId: drv.id, date: today, orderIds: pendingAssigned });
      h = await db.handover.findUniqueOrThrow({ where: { id: d.id } });
      steps.push(`Падаан ${h.number} үүслээ`);
    }
    if (h && h.status !== 'RECEIVED') {
      if (h.status === 'DRAFT') await H.prepareHandover(actor, h.id);
      if (h.status === 'DRAFT' || h.status === 'PREPARED') {
        const det = await H.handoverDetail(actor, h.id);
        for (const it of det.items) await H.setCheck(actor, h.id, { variantId: it.variantId, checked: true });
        await H.confirmHandover(actor, h.id);
      }
      await H.setDriverCheck(drv, h.id, { variantId: 'all', checked: true });
      await H.receiveHandover(drv, h.id);
      steps.push(`Падааныг агуулах өгч, ${drv.name} хүлээн авлаа`);
    }

    // 6. Хүргэсэн / Цуцалсан / Маргааш
    let dN = 0; let cN = 0; let pN = 0;
    for (const r of pv.rows) {
      const id = ids.get(r.number)!;
      const o = await db.order.findUniqueOrThrow({ where: { id }, select: { status: true, version: true } });
      if (o.status !== 'OUT_FOR_DELIVERY') continue;
      if (r.action === 'DELIVER') { await DR.deliverOrder(drv, id, { payment: r.payment ?? 'CASH', note: 'Хуучин ERP-ээс' }); dN++; }
      else if (r.action === 'CANCEL') { await DR.driverCancel(drv, id, { note: `Хуучин ERP: ${r.statusText}` }); cN++; }
      else if (r.action === 'POSTPONE') { await DR.postponeOrder(drv, id, {}); pN++; }
    }
    if (dN || cN || pN) steps.push(`Хүргэсэн ${dN}, цуцалсан ${cN}, маргааш ${pN}`);

    // 7. Цалин — нягтлангийн «Цалин бодох арга» (switch, #139)-аар бодогдоно; оруулалт гар хүргэхгүй
    await writeAudit(actor, 'legacy.import', 'User', drv.id, { driver: drv.name, orders: pv.rows.length, created: createdN, delivered: dN, cancelled: cN, postponed: pN }, db, ['order', 'delivery']);
    const day = await C.computeDriverDay(db, today, drv.id);
    return { ok: true, steps, tempPassword, driver: { id: drv.id, name: drv.name, phone: pv.driver.phone }, day, expected: pv.summary };
  } catch (e) {
    if (e instanceof Error) (e as Error & { steps?: string[] }).steps = steps;
    throw e;
  } finally {
    running = false;
  }
}
