import { AppError } from './errors';

/**
 * Аудит #141: хүнд тайлан / экспорт / тулгалтын ЗЭРЭГ тоог хязгаарлана — database-ийн холболт (20) бүгд хүнд хүсэлтэд
 * эзлэгдэж, нягтлан, жолооч, операторын энгийн хүсэлт гацахаас сэргийлнэ. Нэг процесс (standalone) тул санах ойд.
 *  • Бүх хүнд хүсэлт нийт HEAVY_MAX-аас ихгүй зэрэг; түлхүүр тус бүр өөрийн дээд хязгаартай (жишээ нь бараа Excel — 1).
 *  • Сул суудал WAIT_MS дотор гарахгүй бол 429 «Систем ачаалалтай» (хүсэлт хүлээгээд холболт эзлэхгүй).
 */
const HEAVY_MAX = Number(process.env.HEAVY_MAX ?? 3);
const WAIT_MS = Number(process.env.HEAVY_WAIT_MS ?? 20_000);

type Gate = { busy: number; queue: (() => void)[] };
const gates = new Map<string, Gate>();
const gate = (k: string) => { let g = gates.get(k); if (!g) { g = { busy: 0, queue: [] }; gates.set(k, g); } return g; };

async function acquire(k: string, max: number, deadline: number): Promise<void> {
  const g = gate(k);
  if (g.busy < max) { g.busy++; return; }
  await new Promise<void>((resolve, reject) => {
    const wake = () => { clearTimeout(t); g.busy++; resolve(); };
    const t = setTimeout(() => { const i = g.queue.indexOf(wake); if (i >= 0) g.queue.splice(i, 1); reject(busy()); }, Math.max(0, deadline - Date.now()));
    g.queue.push(wake);
  });
}
function release(k: string) {
  const g = gate(k);
  g.busy--;
  const next = g.queue.shift();
  if (next) next();
}
const busy = () => new AppError(429, 'Систем түр ачаалалтай байна — хэдэн секундийн дараа дахин оролдоно уу', 'busy');

/** fn-ийг хүнд хүсэлтийн хязгаар дотор ажиллуулна. key — тусгай хязгаар (жишээ нь 'products-export', 1) */
export async function withHeavy<T>(fn: () => Promise<T>, key?: { name: string; max: number }): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  if (key) await acquire(key.name, key.max, deadline);
  try {
    await acquire('heavy', HEAVY_MAX, deadline);
    try { return await fn(); } finally { release('heavy'); }
  } finally { if (key) release(key.name); }
}

/** Тестэд: одоогийн ачаалал */
export function _heavyState() { return Object.fromEntries([...gates].map(([k, g]) => [k, { busy: g.busy, waiting: g.queue.length }])); }
