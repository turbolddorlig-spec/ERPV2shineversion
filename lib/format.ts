/** ₮195,000 */
export const money = (n: number | null | undefined) => (n === null || n === undefined ? '—' : '₮' + n.toLocaleString('en-US'));

/** Улаанбаатарын цагаар: 2026.11.10 21:11 */
export function ubDateTime(s: string | Date | null | undefined): string {
  if (!s) return '—';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ulaanbaatar', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(s)).map((x) => [x.type, x.value]));
  return `${p.year}.${p.month}.${p.day} ${p.hour}:${p.minute}`;
}

export const CATEGORY_DOT: Record<string, string> = {
  gray: '#8E939D', orange: '#E8590C', blue: '#2563EB', green: '#15803D', teal: '#0F766E', violet: '#7C3AED', rose: '#E11D48', amber: '#B45309',
};
