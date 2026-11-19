/**
 * #182 Хуучин ERP → V2 өгөгдөл шилжүүлэх (эзний шийдвэр 2026-11-19).
 *
 *   ОРНО: ажилчид + эрх (хуучин bcrypt нууц үгээрээ нэвтэрнэ), ангилал, улирал, агуулах (үлдэгдэлгүй), бараа + зураг (үлдэгдэл 0),
 *         пэйж, хар жагсаалт, бүх захиалга (заасан өдрүүдэд ҮҮССЭНээс бусад), нээлттэй өр (жолоочийн хувийн дэвтэр, компанийн өр, ажилчдын өр).
 *   ОРОХГҮЙ: нийлүүлэгч (дэлгүүр, хэрэглэгч), агуулахын үлдэгдэл (эзэн тоолж оруулна), устгасан захиалга.
 *
 * Аюулгүй: хуучин database-ийг ЗӨВХӨН уншина. Дахин ажиллуулахад давхардахгүй (код, утас, legacy-<id> түлхүүрээр), тасарвал үргэлжилнэ.
 * Мэдэгдэл (SMS, Meta), үлдэгдлийн журнал, падаан огт үүсэхгүй — захиалга түүх болж орно.
 *
 * Хэрэглээ (апп контейнер дотор): node dist/legacy-migrate.mjs --legacy <postgres url> [--images DIR] [--skip-from 2026-11-18 --skip-to 2026-11-20]
 *   [--open new|cancel] [--analyze]   (--analyze: зөвхөн хуучин өгөгдлийг тоолж тайлан, юу ч бичихгүй)
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Prisma, PrismaClient, type OrderStatus, type Role, type CancelReason, type DeliveryPayment, type CompanyDebtKind } from '@prisma/client';
import { saveProductImage } from '../../lib/storage';
import { variantCode, cleanProductCode } from '../../lib/catalog/variants';

const db = new PrismaClient();
type Args = { legacy: string; images: string | null; skipFrom: string | null; skipTo: string | null; open: 'new' | 'cancel'; analyze: boolean };
function args(): Args {
  const a = process.argv.slice(2);
  const get = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] ?? null : null; };
  const legacy = get('--legacy') ?? process.env.LEGACY_URL ?? '';
  if (!legacy) { console.error('--legacy <postgres url> заавал'); process.exit(1); }
  // Эзний шийдвэр (2026-11-20): дуусаагүй хуучин захиалга «Цуцалсан» болж орно (--open new — идэвхтэй болгох)
  const open = get('--open') === 'new' ? 'new' : 'cancel';
  return { legacy, images: get('--images'), skipFrom: get('--skip-from'), skipTo: get('--skip-to'), open, analyze: a.includes('--analyze') };
}
const A = args();
const L = new PrismaClient({ datasourceUrl: A.legacy });
const q = <T>(sql: string, ...p: unknown[]) => L.$queryRawUnsafe<T[]>(sql, ...p);
const UB = 8 * 3600_000;
const ubYmd = (d: Date) => new Date(d.getTime() + UB).toISOString().slice(0, 10);
const dateOnly = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
const log = (...m: unknown[]) => console.log('[шилжүүлэлт]', ...m);
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), mode: A.analyze ? 'analyze' : 'import' };

// ───────────── Хэрэгслүүд ─────────────
function phone8(v: unknown): string | null {
  let d = String(v ?? '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('976')) d = d.slice(3);
  return /^[0-9]{8}$/.test(d) ? d : null;
}
const ROLE: Record<string, Role | null> = {
  SUPER_ADMIN: 'SUPER_ADMIN', ADMIN: 'ADMIN', OPERATOR_LEAD: 'OPERATOR_LEAD', OPERATOR: 'OPERATOR', DRIVER: 'DRIVER', DRIVER_LEAD: 'DRIVER_LEAD',
  ACCOUNTING: 'ACCOUNTING', WAREHOUSE: 'WAREHOUSE', WAREHOUSE_STAFF: 'WAREHOUSE', MARKETING: 'MARKETING', MARKETING_LEAD: 'MARKETING_LEAD',
  PENALTY_OFFICER: 'PENALTY_OFFICER', PROCUREMENT_OFFICER: 'PURCHASER',
  EXTERNAL_DELIVERY: 'DRIVER', // эзэн шийднэ — идэвхгүй болгож оруулна
  SUPPLIER: null, // эзний шийдвэр: нийлүүлэгч орохгүй
};
async function tableExists(name: string) {
  const r = await q<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`, name);
  return (r[0]?.n ?? 0) > 0;
}
const FINAL = new Set(['DELIVERED', 'CANCELLED', 'CANCELLED_BY_DRIVER']);
const PENDING_PAY = new Set(['PENDING', 'NOT_PAID']);
function skipped(createdAt: Date) {
  if (!A.skipFrom || !A.skipTo) return false;
  const d = ubYmd(createdAt);
  return d >= A.skipFrom && d <= A.skipTo;
}

// ───────────── 0. Шинжилгээ (юу ч бичихгүй) ─────────────
async function analyze() {
  const [users, products, images, orders, deleted, skippedN, blacklist, pages] = await Promise.all([
    q<{ role: string; n: number }>(`SELECT role::text, count(*)::int AS n FROM "User" GROUP BY 1 ORDER BY 2 DESC`),
    q<{ n: number; active: number }>(`SELECT count(*)::int AS n, count(*) FILTER (WHERE active)::int AS active FROM "Product"`),
    q<{ n: number }>(`SELECT count(*)::int AS n FROM "ProductImage"`),
    q<{ status: string; n: number; total: string }>(`SELECT status::text, count(*)::int AS n, COALESCE(sum("orderTotal"),0)::text AS total FROM "Order" WHERE "deletedAt" IS NULL GROUP BY 1 ORDER BY 2 DESC`),
    q<{ n: number }>(`SELECT count(*)::int AS n FROM "Order" WHERE "deletedAt" IS NOT NULL`),
    A.skipFrom && A.skipTo ? q<{ n: number }>(`SELECT count(*)::int AS n FROM "Order" WHERE "deletedAt" IS NULL AND (("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Ulaanbaatar')::date BETWEEN $1::date AND $2::date`, A.skipFrom, A.skipTo) : Promise.resolve([{ n: 0 }]),
    q<{ n: number }>(`SELECT count(*)::int AS n FROM blacklisted_phones`),
    q<{ name: string; n: number }>(`SELECT "shopSource" AS name, count(*)::int AS n FROM "Order" WHERE "deletedAt" IS NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 100`),
  ]);
  const open = await q<{ status: string; n: number }>(`SELECT status::text, count(*)::int AS n FROM "Order" WHERE "deletedAt" IS NULL AND status::text NOT IN ('DELIVERED','CANCELLED','CANCELLED_BY_DRIVER')
    ${A.skipFrom && A.skipTo ? `AND (("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Ulaanbaatar')::date NOT BETWEEN '${A.skipFrom}'::date AND '${A.skipTo}'::date` : ''} GROUP BY 1 ORDER BY 2 DESC`);
  report.analyze = { users, products: products[0], images: images[0]?.n, orders, deletedOrders: deleted[0]?.n, skippedByDate: skippedN[0]?.n, openNotSkipped: open, blacklist: blacklist[0]?.n, pages: pages.length, topPages: pages.slice(0, 15) };
}

// ───────────── 1. Ажилчид ─────────────
const userMap = new Map<string, { id: string; name: string }>(); // хуучин id → шинэ
let migrator: { id: string; name: string; roles: Role[] };
async function migrateUsers() {
  const rows = await q<{ id: string; phone: string; passwordHash: string; name: string; displayName: string | null; role: string; isActive: boolean; createdAt: Date }>(`SELECT id, phone, "passwordHash", name, "displayName", role::text AS role, "isActive", "createdAt" FROM "User" ORDER BY "createdAt"`);
  const r = { total: rows.length, created: 0, existing: 0, skippedSupplier: 0, badPhone: [] as string[], externalDelivery: [] as string[] };
  for (const u of rows) {
    const role = ROLE[u.role];
    if (role === null) { r.skippedSupplier++; continue; }
    const phone = phone8(u.phone);
    if (!phone) { r.badPhone.push(`${u.name} (${u.phone})`); continue; }
    const name = (u.displayName || u.name || phone).trim().slice(0, 100);
    const ex = await db.user.findUnique({ where: { phone } });
    if (ex) { userMap.set(u.id, { id: ex.id, name: ex.name }); r.existing++; continue; }
    const ext = u.role === 'EXTERNAL_DELIVERY';
    if (ext) r.externalDelivery.push(name);
    const nu = await db.user.create({ data: { phone, name, roles: [role ?? 'OPERATOR'], passwordHash: u.passwordHash || 'x', isActive: u.isActive && !ext, createdAt: u.createdAt } });
    userMap.set(u.id, { id: nu.id, name: nu.name });
    r.created++;
  }
  report.users = r;
}
/** Хуучин «opp» (оператор нэр) → хэрэглэгч; олдохгүй бол «Хуучин ERP» (нэвтрэх боломжгүй) */
const nameMap = new Map<string, { id: string; name: string }>();
let legacyUser: { id: string; name: string };
async function prepareOperators() {
  const ph = '00000001';
  const ex = await db.user.findUnique({ where: { phone: ph } });
  legacyUser = ex ? { id: ex.id, name: ex.name } : await db.user.create({ data: { phone: ph, name: 'Хуучин ERP', roles: ['OPERATOR'], passwordHash: 'x', isActive: false } }).then((u) => ({ id: u.id, name: u.name }));
  for (const u of await db.user.findMany({ select: { id: true, name: true } })) nameMap.set(u.name.trim().toLowerCase(), u);
  const sa = await db.user.findFirst({ where: { roles: { has: 'SUPER_ADMIN' }, isActive: true }, orderBy: { createdAt: 'asc' } });
  migrator = { id: sa?.id ?? legacyUser.id, name: 'Хуучин ERP шилжүүлэлт', roles: ['SUPER_ADMIN'] };
}

// ───────────── 2. Ангилал, улирал, агуулах ─────────────
const catMap = new Map<string, number>(); const seasonMap = new Map<string, number>();
async function catId(name: string | null | undefined) {
  const n = String(name ?? '').trim().slice(0, 60);
  if (!n) return null;
  if (catMap.has(n)) return catMap.get(n)!;
  const c = await db.category.upsert({ where: { name: n }, create: { name: n }, update: {} });
  catMap.set(n, c.id); return c.id;
}
async function seasonId(name: string | null | undefined) {
  const n = String(name ?? '').trim().slice(0, 60);
  if (!n) return null;
  if (seasonMap.has(n)) return seasonMap.get(n)!;
  const s = await db.season.upsert({ where: { name: n }, create: { name: n }, update: {} });
  seasonMap.set(n, s.id); return s.id;
}
async function migrateCatalogBasics() {
  if (await tableExists('product_categories')) for (const c of await q<{ name: string; sort_order: number }>(`SELECT name, sort_order FROM product_categories ORDER BY sort_order`)) await catId(c.name);
  const whs = await q<{ name: string; isPrimary: boolean; isActive: boolean }>(`SELECT name, "isPrimary", "isActive" FROM "Warehouse" ORDER BY "isPrimary" DESC, "createdAt"`);
  let created = 0;
  for (const w of whs) {
    const name = w.name.trim().slice(0, 80);
    if (await db.warehouse.findUnique({ where: { name } })) continue;
    const hasPrimary = (await db.warehouse.count({ where: { isPrimary: true } })) > 0;
    const max = await db.warehouse.aggregate({ _max: { sortOrder: true } });
    const nw = await db.warehouse.create({ data: { name, isPrimary: !hasPrimary, isActive: w.isActive, sortOrder: (max._max.sortOrder ?? 0) + 1 } });
    await db.stockLocation.create({ data: { kind: 'WAREHOUSE', warehouseId: nw.id, name } });
    created++;
  }
  report.warehouses = { total: whs.length, created };
}

// ───────────── 3. Бараа + зураг ─────────────
const variantOf = new Map<number, { variantId: number; productId: number; code: string; name: string; label: string; imageKey: string | null }>(); // хуучин бараа id → эхний хувилбар
let imageIndex: Map<string, string> | null = null;
async function indexImages(dir: string) {
  const m = new Map<string, string>();
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p); else m.set(e.name.toLowerCase(), p);
    }
  };
  await walk(dir);
  return m;
}
function colorsOf(cv: string | null, color: string | null): string[] {
  const out: string[] = [];
  if (cv) { try { const j = JSON.parse(cv) as { name?: unknown }[]; if (Array.isArray(j)) for (const x of j) { const n = String(x?.name ?? '').trim().slice(0, 40); if (n && !out.includes(n)) out.push(n); } } catch { /* хуучин буруу JSON */ } }
  if (!out.length && color?.trim()) out.push(color.trim().slice(0, 40));
  return out;
}
async function migrateProducts() {
  const seasons = (await tableExists('product_season_assignments')) ? new Map((await q<{ product_id: number; season: string }>(`SELECT product_id, season FROM product_season_assignments`)).map((s) => [s.product_id, s.season])) : new Map<number, string>();
  const imgs = await q<{ productId: number; imageUrl: string; displayOrder: number; isMain: boolean }>(`SELECT "productId", "imageUrl", "displayOrder", "isMain" FROM "ProductImage" ORDER BY "productId", "isMain" DESC, "displayOrder"`);
  const imgBy = new Map<number, string[]>();
  for (const i of imgs) { const a = imgBy.get(i.productId) ?? []; if (!a.includes(i.imageUrl)) a.push(i.imageUrl); imgBy.set(i.productId, a); }
  const rows = await q<{ id: number; code: string; name: string; category: string; description: string | null; size: string | null; color: string | null; price: number; image: string | null; active: boolean; colorVariants: string | null; createdAt: Date }>(
    `SELECT id, code, name, category, description, size, color, price, image, active, "colorVariants", "createdAt" FROM "Product" ORDER BY id`);
  if (A.images) imageIndex = await indexImages(A.images);
  const r = { total: rows.length, created: 0, existing: 0, badCode: [] as string[], zeroPrice: 0, images: 0, imagesMissing: 0, imagesBad: 0 };
  for (const p of rows) {
    // Хоосон зайтай хуучин код («A 12») → «A-12» (V2-д зайгүй)
    const code = cleanProductCode(String(p.code ?? '').trim().replace(/\s+/g, '-'));
    if (!code) { r.badCode.push(`${p.id}:${p.code}`); continue; }
    const ex = await db.product.findUnique({ where: { code }, include: { variants: { orderBy: { sortOrder: 'asc' }, take: 1 }, images: { take: 1, orderBy: { sortOrder: 'asc' } } } });
    if (ex) {
      const v = ex.variants[0];
      if (v) variantOf.set(p.id, { variantId: v.id, productId: ex.id, code: v.code, name: ex.name, label: [v.color, v.size].filter(Boolean).join(' / '), imageKey: ex.images[0]?.fileKey ?? null });
      r.existing++; continue;
    }
    const colors = colorsOf(p.colorVariants, p.color);
    const size = p.size?.trim().slice(0, 40) ?? '';
    const combos = (colors.length ? colors : ['']).map((c) => ({ color: c, size }));
    if (p.price <= 0) r.zeroPrice++;
    const np = await db.product.create({ data: {
      code, name: p.name.trim().slice(0, 200) || code, description: p.description?.slice(0, 2000) ?? null, categoryId: await catId(p.category), seasonId: await seasonId(seasons.get(p.id)),
      price: Math.max(1, p.price), status: p.active ? 'ACTIVE' : 'DISCONTINUED', colors, sizes: size ? [size] : [], createdById: migrator.id, createdAt: p.createdAt,
      variants: { create: combos.map((c, i) => ({ code: variantCode(code, c), color: c.color, size: c.size, sortOrder: i })) },
    }, include: { variants: { orderBy: { sortOrder: 'asc' } } } });
    // Зураг (дискнээс → 3 хэмжээ WEBP)
    let mainKey: string | null = null;
    const urls = [...(imgBy.get(p.id) ?? []), ...(p.image ? [p.image] : [])].filter((u, i, a) => a.indexOf(u) === i);
    let order = 0;
    for (const u of urls) {
      if (!imageIndex) break;
      const base = path.basename(u.split('?')[0]!).toLowerCase();
      const file = imageIndex.get(base);
      if (!file) { r.imagesMissing++; continue; }
      try {
        const buf = await readFile(file);
        const s = await saveProductImage(np.id, buf);
        await db.productImage.create({ data: { productId: np.id, fileKey: s.fileKey, width: s.width, height: s.height, bytes: s.bytes, isMain: order === 0, sortOrder: order } });
        if (order === 0) mainKey = s.fileKey;
        order++; r.images++;
      } catch { r.imagesBad++; }
    }
    const v = np.variants[0]!;
    variantOf.set(p.id, { variantId: v.id, productId: np.id, code: v.code, name: np.name, label: [v.color, v.size].filter(Boolean).join(' / '), imageKey: mainKey });
    r.created++;
    if (r.created % 500 === 0) log(`бараа ${r.created}/${rows.length}`);
  }
  report.products = r;
}
/** Олдохгүй бараатай мөрд — нэг «Хуучин бараа» (нэр нь мөрөнд хадгалагдана) */
let unknownVariant: { variantId: number; productId: number } | null = null;
let unknownP: Promise<{ variantId: number; productId: number }> | null = null;
function unknownLine() { if (unknownVariant) return Promise.resolve(unknownVariant); unknownP ??= unknownLineRaw(); return unknownP; }
async function unknownLineRaw() {
  const code = 'LEGACY-UNKNOWN';
  const ex = await db.product.findUnique({ where: { code }, include: { variants: true } });
  const p = ex ?? await db.product.create({ data: { code, name: 'Хуучин ERP — тодорхойгүй бараа', price: 1, status: 'ARCHIVED', createdById: migrator.id, variants: { create: [{ code, color: '', size: '' }] } }, include: { variants: true } });
  unknownVariant = { variantId: p.variants[0]!.id, productId: p.id };
  return unknownVariant;
}

// ───────────── 4. Пэйж ─────────────
const pageMap = new Map<string, Promise<number>>();
/** Эзний шийдвэр: «Greenshopy» ба «Green shopy» нэг пэйж — зай, том/жижиг үсгийг үл харгалзана; хамгийн олон захиалгатай бичлэгээр нэрлэнэ */
const pageKey = (s: string) => s.toLowerCase().replace(/\s+/g, '');
const pageCanon = new Map<string, string>();
function pageId(name: string | null | undefined) {
  const raw = String(name ?? '').trim().slice(0, 100) || 'Хуучин ERP';
  const n = pageCanon.get(pageKey(raw)) ?? raw;
  if (!pageMap.has(n)) pageMap.set(n, db.page.upsert({ where: { name: n }, create: { name: n }, update: {} }).then((p) => p.id));
  return pageMap.get(n)!;
}
async function migratePages() {
  let n = 0;
  const names = await q<{ name: string | null; n: number }>(`SELECT "shopSource" AS name, count(*)::int AS n FROM "Order" WHERE "deletedAt" IS NULL GROUP BY 1 ORDER BY 2 DESC`);
  const merged: Record<string, string[]> = {};
  for (const x of names) {
    const raw = String(x.name ?? '').trim().slice(0, 100); if (!raw) continue;
    const k = pageKey(raw);
    if (!pageCanon.has(k)) pageCanon.set(k, raw); else (merged[pageCanon.get(k)!] ??= []).push(raw);
  }
  report.pagesMerged = merged;
  if (await tableExists('FacebookPage')) for (const p of await q<{ pageName: string; displayName: string | null }>(`SELECT "pageName", "displayName" FROM "FacebookPage" WHERE "isActive"`)) { await pageId(p.displayName || p.pageName); n++; }
  report.pages = { facebookPages: n };
}

// ───────────── 5. Захиалга ─────────────
interface OldOrder {
  id: number; orderNumber: string; customerPhone: string; extraPhone: string | null; address: string; district: string | null; province: string; operatorNote: string | null;
  opp: string; shopSource: string; status: string; prepaid: boolean; orderTotal: number; driver: string | null; assignedDate: Date | null; products: unknown; history: unknown;
  createdAt: Date; updatedAt: Date; scheduledDate: Date | null; deletedAt: Date | null; deleteReason: string | null; outForDeliveryAt: Date | null; deliveryPaymentMethod: string | null;
  isPaidToDriver: boolean; customerNotes: string | null; deliveryDate: Date | null; discountAmount: number; driverIssueNote: string | null;
}
type Hist = { timestamp?: string; action?: string; user?: string; note?: string };
function lastHist(h: unknown, re: RegExp): Hist | null {
  if (!Array.isArray(h)) return null;
  for (let i = h.length - 1; i >= 0; i--) { const e = h[i] as Hist; if (e && re.test(String(e.action ?? ''))) return e; }
  return null;
}
const dt = (s: string | undefined, fb: Date) => { const d = s ? new Date(s) : null; return d && !Number.isNaN(d.getTime()) ? d : fb; };
const orderIdMap = new Map<number, number>();
async function migrateOrders() {
  const r = { scanned: 0, created: 0, existing: 0, deleted: 0, skippedDate: 0, badPhone: 0, numberTaken: 0, errors: [] as string[], unknownLines: 0, byStatus: {} as Record<string, number>, openAs: A.open, totalSum: 0 };
  const existing = new Map((await db.order.findMany({ where: { idemKey: { startsWith: 'legacy-' } }, select: { id: true, idemKey: true } })).map((o) => [o.idemKey, o.id]));
  let last = 0;
  for (;;) {
    const rows = await q<OldOrder>(`SELECT id, "orderNumber", "customerPhone", "extraPhone", address, district, province, "operatorNote", opp, "shopSource", status::text AS status, prepaid, "orderTotal",
      driver, "assignedDate", products, history, "createdAt", "updatedAt", "scheduledDate", "deletedAt", "deleteReason", "outForDeliveryAt", "deliveryPaymentMethod", "isPaidToDriver",
      "customerNotes", "deliveryDate", "discountAmount", "driverIssueNote" FROM "Order" WHERE id > $1 ORDER BY id LIMIT 1000`, last);
    if (!rows.length) break;
    last = rows[rows.length - 1]!.id;
    const todo: { o: OldOrder; phone: string }[] = [];
    for (const o of rows) {
      r.scanned++;
      const key = `legacy-${o.id}`;
      if (existing.has(key)) { orderIdMap.set(o.id, existing.get(key)!); r.existing++; continue; }
      if (o.deletedAt) { r.deleted++; continue; }
      if (skipped(o.createdAt)) { r.skippedDate++; continue; }
      const phone = phone8(o.customerPhone);
      if (!phone) { r.badPhone++; continue; }
      todo.push({ o, phone });
    }
    // 8 зэрэг (захиалга бүр өөрийн transaction-д — нэг нь алдаатай байсан ч бусад нь орно)
    let k = 0;
    const worker = async () => {
      while (k < todo.length) {
        const { o, phone } = todo[k++]!;
        try {
          const id = await createOrder(o, phone, r);
          if (id) { orderIdMap.set(o.id, id); r.created++; }
        } catch (e) {
          const m = (e as Error).message;
          if (/number/.test(m) && /Unique/.test(m)) r.numberTaken++;
          else if (r.errors.length < 200) r.errors.push(`${o.orderNumber}: ${m.slice(0, 160)}`);
        }
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    log(`захиалга ${r.scanned} уншсан · ${r.created} орсон`);
  }
  // Шинэ захиалгын дугаар хуучинтай давхцахгүй
  const mx = await db.$queryRaw<{ m: bigint | null }[]>`SELECT max(number::bigint) AS m FROM "Order" WHERE number ~ '^[0-9]{1,18}$'`;
  const next = Number(mx[0]?.m ?? 0) + 1;
  await db.$executeRawUnsafe(`SELECT setval('order_number_seq', GREATEST((SELECT last_value FROM order_number_seq), ${next}), false)`);
  report.orders = r;
}
async function createOrder(o: OldOrder, phone: string, r: { unknownLines: number; byStatus: Record<string, number>; totalSum: number }) {
  // Мөрүүд (ижил хувилбар нэгтгэнэ — @@unique(orderId, variantId))
  const items = Array.isArray(o.products) ? (o.products as { productId?: number; productName?: string; name?: string; displayName?: string; code?: string; quantity?: number; price?: number }[]) : [];
  const lines = new Map<number, { variantId: number; productId: number; code: string; name: string; label: string; imageKey: string | null; price: number; qty: number; value: number }>();
  for (const it of items) {
    const qty = Math.max(1, Math.round(Number(it.quantity) || 1));
    const price = Math.max(1, Math.round(Number(it.price) || 1));
    const v = it.productId ? variantOf.get(Number(it.productId)) : undefined;
    const tgt = v ?? (r.unknownLines++, { ...(await unknownLine()), code: it.code ?? 'LEGACY-UNKNOWN', name: '', label: '', imageKey: null });
    const nm = String(it.displayName || it.productName || it.name || tgt.name || 'Хуучин бараа').slice(0, 200);
    const prev = lines.get(tgt.variantId);
    // Нэгтгэхэд нийт дүн хадгалагдана: нэгж үнэ = нийт ÷ тоо
    if (prev) { prev.qty += qty; prev.value += price * qty; prev.price = Math.max(1, Math.round(prev.value / prev.qty)); if (!v && !prev.name.includes(nm)) prev.name = `${prev.name}; ${nm}`.slice(0, 200); }
    else lines.set(tgt.variantId, { variantId: tgt.variantId, productId: tgt.productId, code: tgt.code, name: v ? tgt.name : nm, label: tgt.label, imageKey: tgt.imageKey, price, qty, value: price * qty });
  }
  if (!lines.size) { const u = await unknownLine(); lines.set(u.variantId, { ...u, code: 'LEGACY-UNKNOWN', name: 'Хуучин бараа (жагсаалтгүй)', label: '', imageKey: null, price: Math.max(1, o.orderTotal), qty: 1, value: Math.max(1, o.orderTotal) }); r.unknownLines++; }
  const subtotal = [...lines.values()].reduce((n, l) => n + l.price * l.qty, 0);
  const total = Math.max(0, o.orderTotal);
  const diff = total - subtotal;
  const discount = diff < 0 ? -diff : 0; const deliveryFee = diff > 0 ? diff : 0;

  // Төлөв
  const final = FINAL.has(o.status);
  let status: OrderStatus; let cancel: { reason: CancelReason; note: string | null; at: Date; by: string | null } | null = null;
  let delivered: { at: Date; by: string | null; payment: DeliveryPayment } | null = null;
  if (o.status === 'DELIVERED') {
    status = 'DELIVERED';
    const h = lastHist(o.history, /DELIVER|ХҮРГЭ/i);
    const m = String(o.deliveryPaymentMethod ?? '').toUpperCase();
    const payment: DeliveryPayment = o.prepaid ? 'PREPAID' : o.isPaidToDriver === false ? 'UNPAID' : m === 'CASH' ? 'CASH' : m ? 'BANK' : 'CASH';
    delivered = { at: dt(h?.timestamp, o.updatedAt), by: h?.user ?? null, payment };
  } else if (final) {
    status = 'CANCELLED';
    const h = lastHist(o.history, /CANCEL|ЦУЦА/i);
    cancel = { reason: o.status === 'CANCELLED_BY_DRIVER' ? 'DRIVER_CANCELLED' : 'OTHER', note: (h?.note || o.deleteReason || o.driverIssueNote || 'Хуучин ERP').slice(0, 500), at: dt(h?.timestamp, o.updatedAt), by: h?.user ?? null };
  } else if (A.open === 'cancel') {
    status = 'CANCELLED';
    cancel = { reason: 'OTHER', note: `Хуучин ERP-д дуусаагүй (${o.status}) — шилжүүлэх үед хаагдсан`, at: new Date(), by: 'Хуучин ERP шилжүүлэлт' };
  } else {
    status = PENDING_PAY.has(o.status) ? 'PENDING_PAYMENT' : 'NEW';
  }
  r.byStatus[`${o.status}→${status}`] = (r.byStatus[`${o.status}→${status}`] ?? 0) + 1;
  r.totalSum += total;

  const op = nameMap.get(String(o.opp ?? '').trim().toLowerCase()) ?? legacyUser;
  const drv = o.driver ? userMap.get(o.driver) : undefined;
  const extra = phone8(o.extraPhone);
  const dd = o.deliveryDate ? ubYmd(o.deliveryDate) : o.scheduledDate ? ubYmd(o.scheduledDate) : ubYmd(o.createdAt);
  const note = [o.operatorNote, o.customerNotes].filter(Boolean).join(' · ').slice(0, 1000) || null;
  const prepaidPaid = o.prepaid && (o.status === 'PAYMENT_RECEIVED' || o.status === 'DELIVERED');
  const data: Prisma.OrderUncheckedCreateInput = {
    number: String(o.orderNumber).slice(0, 20), status, phone, extraPhone: extra && extra !== phone ? extra : null,
    province: (o.province || 'Улаанбаатар').slice(0, 60), district: o.district?.slice(0, 60) ?? null, addressDetail: (o.address || '—').slice(0, 500), note,
    pageId: await pageId(o.shopSource), operatorId: op.id, operatorName: String(o.opp || op.name).slice(0, 100),
    deliveryDate: dateOnly(dd), prepaid: o.prepaid, paidAmount: prepaidPaid ? total : 0,
    confirmedAt: status === 'PENDING_PAYMENT' ? null : o.createdAt,
    subtotal, discount, deliveryFee, total, deliveryFeeEdited: true,
    driverId: status === 'DELIVERED' && drv ? drv.id : null, driverName: status === 'DELIVERED' ? (drv?.name ?? null) : null,
    assignedAt: status === 'DELIVERED' ? o.assignedDate : null, outForDeliveryAt: status === 'DELIVERED' ? o.outForDeliveryAt : null,
    ...(cancel ? { cancelReason: cancel.reason, cancelNote: cancel.note, cancelledAt: cancel.at, cancelledByName: cancel.by } : {}),
    ...(delivered ? { deliveredAt: delivered.at, deliveredByName: delivered.by ?? drv?.name ?? null, deliveryPayment: delivered.payment } : {}),
    idemKey: `legacy-${o.id}`, createdAt: o.createdAt,
    lines: { create: [...lines.values()].map((l) => ({ variantId: l.variantId, productId: l.productId, code: l.code, name: l.name, label: l.label, imageKey: l.imageKey, listPrice: l.price, unitPrice: l.price, qty: l.qty })) },
  };
  return db.$transaction(async (tx) => {
    const c = await tx.order.create({ data, select: { id: true } });
    // Нээлттэй захиалга — барааг нөөцөлнө (V2-ийн дүрэм: «Шинэ» захиалга бараа нөөцөлдөг)
    if (status === 'NEW' || status === 'PENDING_PAYMENT') await tx.stockReservation.createMany({ data: [...lines.values()].map((l) => ({ ref: `order:${c.id}`, orderId: c.id, variantId: l.variantId, qty: l.qty })) });
    return c.id;
  });
}

// ───────────── 6. Хар жагсаалт, өр ─────────────
async function migrateBlacklist() {
  const rows = await q<{ phone: string; reason: string; reported_by: string | null; order_number: string | null; created_at: Date; is_active: boolean }>(`SELECT phone, reason, reported_by, order_number, created_at, is_active FROM blacklisted_phones ORDER BY id`);
  const r = { total: rows.length, created: 0, existing: 0, badPhone: 0 };
  for (const b of rows) {
    const phone = phone8(b.phone);
    if (!phone) { r.badPhone++; continue; }
    const reason = (b.reason || 'Хуучин ERP').slice(0, 300);
    if (await db.blacklistEntry.findFirst({ where: { phone, reason, orderNumber: b.order_number } })) { r.existing++; continue; }
    await db.blacklistEntry.create({ data: { phone, reason, orderNumber: b.order_number, reportedBy: (b.reported_by || 'Хуучин ERP').slice(0, 100), isActive: b.is_active, createdAt: b.created_at } });
    r.created++;
  }
  report.blacklist = r;
}
const KIND: Record<string, CompanyDebtKind> = { WAREHOUSE_GOODS_NOT_RECEIVED: 'GOODS_NOT_RETURNED', PRODUCT_NOT_DELIVERED: 'PRODUCT_NOT_DELIVERED', ACCOUNTING_MISMATCH: 'ACCOUNTING_MISMATCH', SETTLEMENT_DEBT: 'SETTLEMENT_DEBT', OTHER: 'OTHER' };
async function migrateDebts() {
  const r = { customer: 0, customerSkipped: 0, company: 0, companySkipped: 0, staff: 0, staffSkipped: 0, companySum: 0, staffSum: 0, customerSum: 0 };
  const done = await db.auditLog.findFirst({ where: { action: 'legacy.debts_migrated' } });
  if (done) { report.debts = { alreadyDone: true }; return; }
  // Жолоочийн хувийн «Өрийн дэвтэр» (үйлчлүүлэгч төлөөгүй)
  for (const d of await q<{ orderId: number; driverId: string; orderNumber: string; customerPhone: string; amount: number; createdAt: Date }>(`SELECT "orderId", "driverId", "orderNumber", "customerPhone", amount, "createdAt" FROM "UnpaidDebt" WHERE NOT "isPaid"`)) {
    const oid = orderIdMap.get(d.orderId); const drv = userMap.get(d.driverId);
    if (!oid || !drv || d.amount <= 0) { r.customerSkipped++; continue; }
    await db.driverDebt.create({ data: { orderId: oid, driverId: drv.id, orderNumber: d.orderNumber, phone: phone8(d.customerPhone) ?? d.customerPhone.slice(0, 20), amount: d.amount, createdAt: d.createdAt } });
    r.customer++; r.customerSum += d.amount;
  }
  // Компанид өгөх өр (жолооч)
  for (const d of await q<{ driverId: string; driverName: string; debtType: string; description: string; amount: number; createdAt: Date; createdBy: string }>(`SELECT "driverId", "driverName", "debtType"::text AS "debtType", description, amount, "createdAt", "createdBy" FROM "DriverDebtLedger" WHERE status::text = 'PENDING'`)) {
    const drv = userMap.get(d.driverId);
    if (!drv || d.amount <= 0) { r.companySkipped++; continue; }
    await db.companyDebt.create({ data: { driverId: drv.id, driverName: drv.name, kind: KIND[d.debtType] ?? 'OTHER', description: `[Хуучин ERP] ${d.description}`.slice(0, 500), amount: d.amount, createdAt: d.createdAt, createdByName: (d.createdBy || 'Хуучин ERP').slice(0, 100) } });
    r.company++; r.companySum += d.amount;
  }
  // Ажилчдын өр (цалингаас суутгах)
  for (const d of await q<{ userId: string; userName: string; description: string; totalAmount: number; remainingAmount: number; createdAt: Date; createdByName: string | null }>(`SELECT "userId", "userName", description, "totalAmount", "remainingAmount", "createdAt", "createdByName" FROM "StaffDebt" WHERE "isActive" AND "remainingAmount" > 0`)) {
    const u = userMap.get(d.userId);
    if (!u) { r.staffSkipped++; continue; }
    await db.staffDebt.create({ data: { staffKey: `u:${u.id}`, staffName: u.name, description: `[Хуучин ERP] ${d.description || 'Өр'}`.slice(0, 500), totalAmount: Math.max(d.totalAmount, d.remainingAmount), remainingAmount: d.remainingAmount, createdAt: d.createdAt, createdByName: (d.createdByName || 'Хуучин ERP').slice(0, 100) } });
    r.staff++; r.staffSum += d.remainingAmount;
  }
  await db.auditLog.create({ data: { actorName: 'Хуучин ERP шилжүүлэлт', action: 'legacy.debts_migrated', entityType: 'System', details: r as never, tags: ['system', 'money'] } });
  report.debts = r;
}

// ───────────── 7. Тулгалт ─────────────
async function reconcile() {
  const where = `"deletedAt" IS NULL ${A.skipFrom && A.skipTo ? `AND (("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Ulaanbaatar')::date NOT BETWEEN '${A.skipFrom}'::date AND '${A.skipTo}'::date` : ''}`;
  const [lo] = await q<{ n: number; s: string }>(`SELECT count(*)::int AS n, COALESCE(sum("orderTotal"),0)::text AS s FROM "Order" WHERE ${where}`);
  const [no] = await db.$queryRaw<{ n: number; s: string }[]>`SELECT count(*)::int AS n, COALESCE(sum(total),0)::text AS s FROM "Order" WHERE "idemKey" LIKE 'legacy-%'`;
  const [lp] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM "Product"`);
  const np = await db.product.count({ where: { code: { not: 'LEGACY-UNKNOWN' } } });
  const neg = await db.stockBalance.count({ where: { qty: { lt: 0 } } });
  const moves = await db.stockMove.count();
  report.reconcile = {
    orders: { legacyEligible: lo?.n, imported: no?.n, legacySum: lo?.s, importedSum: no?.s, note: 'зөрүү = утас буруу / алдаатай (дээрх тоонд)' },
    products: { legacy: lp?.n, v2: np }, stockMoves: moves, negativeBalances: neg,
  };
}

async function main() {
  log(A.analyze ? 'Шинжилгээ (юу ч бичихгүй)…' : 'Шилжүүлэлт эхэллээ…');
  await analyze();
  if (!A.analyze) {
    await migrateUsers(); log('ажилчид ✓');
    await prepareOperators();
    await migrateCatalogBasics(); log('ангилал, агуулах ✓');
    await migrateProducts(); log('бараа ✓');
    await migratePages(); log('пэйж ✓');
    await migrateOrders(); log('захиалга ✓');
    await migrateBlacklist(); log('хар жагсаалт ✓');
    await migrateDebts(); log('өр ✓');
    await reconcile();
    await db.auditLog.create({ data: { actorName: 'Хуучин ERP шилжүүлэлт', action: 'legacy.migrated', entityType: 'System', details: JSON.parse(JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))) as never, tags: ['system'] } });
  }
  report.finishedAt = new Date().toISOString();
  const out = JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2);
  console.log('\n===== ТАЙЛАН =====\n' + out);
  if (!A.analyze) await db.appSetting.upsert({ where: { key: 'legacy.report' }, create: { key: 'legacy.report', value: JSON.parse(out) }, update: { value: JSON.parse(out) } });
}
main().catch((e) => { console.error('[шилжүүлэлт] АЛДАА:', e); process.exitCode = 1; }).finally(async () => { await db.$disconnect(); await L.$disconnect(); void stat; });
