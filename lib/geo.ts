/**
 * Хаягийн лавлах (#43, #49). Хуучин системийн жагсаалтаар: Улаанбаатарын 6 төв дүүрэг (хороотой);
 * алслагдсан дүүргүүд (Багануур, Багахангай, Налайх) ба 21 аймаг — «орон нутаг» (урьдчилгаатай).
 * Хорооны тоог шаардлагатай бол энд засна.
 */
export const UB = 'Улаанбаатар';

export const UB_DISTRICTS: Record<string, number> = {
  'Баянгол': 34,
  'Баянзүрх': 43,
  'Сонгинохайрхан': 43,
  'Сүхбаатар': 20,
  'Хан-Уул': 25,
  'Чингэлтэй': 24,
};

export const RURAL = [
  'Архангай', 'Баян-Өлгий', 'Баянхонгор', 'Булган', 'Говь-Алтай', 'Говьсүмбэр', 'Дархан-Уул', 'Дорноговь', 'Дорнод',
  'Дундговь', 'Завхан', 'Орхон', 'Өвөрхангай', 'Өмнөговь', 'Сэлэнгэ', 'Сүхбаатар', 'Төв', 'Увс', 'Ховд', 'Хөвсгөл', 'Хэнтий',
  'Багануур', 'Багахангай', 'Налайх',
];

export const PROVINCES = [UB, ...RURAL];
export const isUB = (province: string) => province === UB;

/** «Улаанбаатар, Баянзүрх дүүрэг, 13-р хороо, Нарны хороолол 45-р байр» (#49) */
export function fullAddress(a: { province: string; district?: string | null; khoroo?: number | null; addressDetail?: string | null }): string {
  const parts: string[] = [a.province];
  if (isUB(a.province) && a.district) parts.push(`${a.district} дүүрэг`);
  if (isUB(a.province) && a.district) parts.push(a.khoroo ? `${a.khoroo}-р хороо` : 'хороо тодорхойгүй');
  if (a.addressDetail?.trim()) parts.push(a.addressDetail.trim());
  return parts.join(', ');
}
