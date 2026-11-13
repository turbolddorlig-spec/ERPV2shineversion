/** Улаанбаатарын (UTC+8) огнооны туслахууд — «өнөөдөр», «маргааш» нь серверийн цагийн бүсээс хамаарахгүй */
const OFFSET = 8 * 3600_000;

/** 'YYYY-MM-DD' — UB-ийн өдөр */
export function ubDay(d: Date = new Date(), addDays = 0): string {
  return new Date(d.getTime() + OFFSET + addDays * 86_400_000).toISOString().slice(0, 10);
}
/** 'YYYY-MM-DD' → @db.Date-д хадгалах Date (UTC шөнө дунд) */
export const dateOnly = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
/** @db.Date → 'YYYY-MM-DD' */
export const ymdOf = (d: Date) => d.toISOString().slice(0, 10);
/** UB өдрийн эхлэлийн мөч (UTC Date) */
export const ubDayStart = (ymd: string) => new Date(`${ymd}T00:00:00+08:00`);
// Аудит #152: байхгүй огноо (2-р сарын 31) хүлээн авахгүй — JS дараагийн сар руу шилжүүлдэг байв
export const isYmd = (s: unknown): s is string => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
};
/** UB цаг (0–23) */
export const ubHour = (d: Date) => new Date(d.getTime() + OFFSET).getUTCHours();
