import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { db } from '../db';
import { badRequest, forbidden } from '../errors';
import { writeAudit } from '../audit';
import { UPLOAD_DIR, MAX_IMAGE_BYTES } from '../storage';
import type { UserActor } from './orders/core';

/**
 * #177 Лого ба нэр (зөвхөн Супер админ, Тохиргоо). Компани бүр өөрийнхөө (MULTI_COMPANY — кодонд биш, тохиргоонд).
 * Нэг нэр + «•» цэг (сонголттой) + нэг зураг → браузерийн tab (нэр, дүрс), зүүн цэсний лого, утасны толгой, нэвтрэх хуудас, хэвлэх падаан.
 * Зураг: JPG/PNG/WEBP → дөрвөлжин тасалж PNG (512 / 180 / 64) дискэнд; хаяг нь хувилбартай (cache солигдоно).
 */
export interface Brand { name: string; dot: boolean; logoVersion: number | null }
export const DEFAULT_BRAND: Brand = { name: 'zahialga', dot: true, logoVersion: null };
const KEY = 'brand';
const DIR = () => path.join(UPLOAD_DIR, 'brand');
export const LOGO_SIZES = { 512: 'logo-512.png', 180: 'logo-180.png', 64: 'logo-64.png' } as const;

let cache: { at: number; v: Brand } | null = null;
export async function getBrand(): Promise<Brand> {
  if (cache && Date.now() - cache.at < 15_000) return cache.v;
  try {
    const row = await db.appSetting.findUnique({ where: { key: KEY } });
    const v = { ...DEFAULT_BRAND, ...((row?.value as Partial<Brand> | null) ?? {}) };
    cache = { at: Date.now(), v };
    return v;
  } catch { return DEFAULT_BRAND; }
}
/** Харуулах нэр: «zahialga•» */
export const brandText = (b: Brand) => `${b.name}${b.dot ? '•' : ''}`;
export const logoUrl = (b: Brand, size: keyof typeof LOGO_SIZES = 512) => (b.logoVersion ? `/brand/${LOGO_SIZES[size]}?v=${b.logoVersion}` : null);

const assertSA = (a: UserActor) => { if (!a.roles.includes('SUPER_ADMIN')) throw forbidden('Лого, нэрийг зөвхөн Супер админ солино'); };
async function save(actor: UserActor, v: Brand, action: string, details: Record<string, unknown>) {
  await db.$transaction(async (tx) => {
    await tx.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: v as never }, update: { value: v as never } });
    await writeAudit(actor, action, 'AppSetting', KEY, details as never, tx, ['settings']);
  });
  cache = null;
  return v;
}

export async function getBrandSettings(actor: UserActor) {
  assertSA(actor);
  const b = await getBrand();
  return { ...b, text: brandText(b), logo: logoUrl(b), defaults: DEFAULT_BRAND };
}

export async function setBrandName(actor: UserActor, input: { name?: unknown; dot?: unknown }) {
  assertSA(actor);
  const name = String(input.name ?? '').replace(/\s+/g, ' ').trim();
  if (name.length < 1 || name.length > 30) throw badRequest('Нэр 1–30 тэмдэгт байна', 'bad_name');
  if (/[<>{}]/.test(name)) throw badRequest('Нэрэнд < > { } тэмдэгт оруулахгүй', 'bad_name');
  const b = await getBrand();
  const v = { ...b, name, dot: input.dot === undefined ? b.dot : !!input.dot };
  return save(actor, v, 'settings.brand_name', { from: brandText(b), to: brandText(v) });
}

export async function setBrandLogo(actor: UserActor, data: Buffer) {
  assertSA(actor);
  if (!data.length) throw badRequest('Зураг сонгоно уу', 'image_empty');
  if (data.length > MAX_IMAGE_BYTES) throw badRequest('Зураг 10MB-аас том байна', 'image_too_large');
  let meta: sharp.Metadata;
  try { meta = await sharp(data, { failOn: 'error' }).metadata(); } catch { throw badRequest('Зургийн файл биш эсвэл эвдэрсэн байна (JPG, PNG, WEBP)', 'image_invalid'); }
  if (!meta.format || !['jpeg', 'png', 'webp'].includes(meta.format)) throw badRequest('Зөвхөн JPG, PNG, WEBP зураг оруулна уу', 'image_type');
  if (!meta.width || !meta.height || meta.width > 8000 || meta.height > 8000) throw badRequest('Зургийн хэмжээ хэт том байна', 'image_dimensions');
  await mkdir(DIR(), { recursive: true });
  for (const [px, file] of Object.entries(LOGO_SIZES)) {
    let out: Buffer;
    try { out = await sharp(data, { failOn: 'error' }).rotate().resize(Number(px), Number(px), { fit: 'cover', position: 'centre' }).png().toBuffer(); }
    catch { throw badRequest('Зургийн файл эвдэрсэн байна. Өөр зураг сонгоно уу.', 'image_invalid'); }
    const f = path.join(DIR(), file);
    await writeFile(f + '.tmp', out); await rename(f + '.tmp', f);
  }
  const b = await getBrand();
  return save(actor, { ...b, logoVersion: Date.now() }, 'settings.brand_logo', { bytes: data.length, width: meta.width, height: meta.height });
}

/** «Анхны руу буцаах» — нэр, цэг, лого бүгд анхны */
export async function resetBrand(actor: UserActor) {
  assertSA(actor);
  await rm(DIR(), { recursive: true, force: true });
  const b = await getBrand();
  return save(actor, DEFAULT_BRAND, 'settings.brand_reset', { from: brandText(b), hadLogo: !!b.logoVersion });
}

/** Нийтэд (нэвтрэхээс өмнө ч — tab-ын дүрс) */
export async function readLogoFile(file: string): Promise<Buffer | null> {
  if (!(Object.values(LOGO_SIZES) as string[]).includes(file)) return null;
  try { return await readFile(path.join(DIR(), file)); } catch { return null; }
}
