/**
 * Хувилбар (SKU) үүсгэх цэвэр функцууд — database-гүй, тест хийхэд хялбар.
 * Бараа бүр дор хаяж нэг хувилбартай: өнгө/хэмжээгүй бол color='' size=''.
 */
export interface Combo { color: string; size: string }

export function cleanAxis(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const t = String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, 30);
    const key = t.toLocaleLowerCase('mn');
    if (t && !seen.has(key)) { seen.add(key); out.push(t); }
  }
  return out.slice(0, 30);
}

export function combos(colors: string[], sizes: string[]): Combo[] {
  const cs = colors.length ? colors : [''];
  const ss = sizes.length ? sizes : [''];
  const out: Combo[] = [];
  for (const color of cs) for (const size of ss) out.push({ color, size });
  return out;
}

/** "Цагаан" → "ЦАГААН", "Хар цагаан" → "ХАР_ЦАГААН", "38/39" → "38/39" */
function part(s: string): string {
  return s.trim().toLocaleUpperCase('mn').replace(/\s+/g, '_').replace(/[^\p{L}\p{N}_/.+]/gu, '');
}

export function variantCode(productCode: string, c: Combo): string {
  return [productCode, c.color ? part(c.color) : '', c.size ? part(c.size) : ''].filter(Boolean).join('-');
}

export function comboKey(c: Combo): string {
  return `${c.color.toLocaleLowerCase('mn')}\u0000${c.size.toLocaleLowerCase('mn')}`;
}

export function variantLabel(c: Combo): string {
  return [c.color, c.size].filter(Boolean).join(' · ') || 'Үндсэн';
}

/** Код: хоосон зайгүй, 1–40 тэмдэгт */
export function cleanProductCode(input: unknown): string | null {
  const code = String(input ?? '').trim().toUpperCase();
  return /^\S{1,40}$/.test(code) ? code : null;
}

/** Тоон кодуудаас дараагийн чөлөөт кодыг санал болгоно: 0887 → 0888 (урттайгаа) */
export function suggestNextCode(existingNumericCodes: string[]): string {
  let max = 0;
  let width = 4;
  for (const c of existingNumericCodes) {
    if (!/^\d+$/.test(c)) continue;
    const n = Number(c);
    if (n > max) { max = n; width = Math.max(width, c.length); }
  }
  return String(max + 1).padStart(width, '0');
}

export const REASON_MIN = 5;
/** Засварын тайлбар (шийдвэр #29): хоосон зайг тооцохгүйгээр дор хаяж 5 тэмдэгт */
export function reasonProblem(reason: unknown): string | null {
  const r = String(reason ?? '').trim();
  return r.replace(/\s/g, '').length >= REASON_MIN ? null : `Засварын тайлбар бичнэ үү (дор хаяж ${REASON_MIN} тэмдэгт)`;
}
