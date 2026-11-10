/**
 * ТЕСТИЙН бараа үүсгэнэ: 12 ангилал, 4 улирал, N бараа (анхдагч 10,000), ~50,000 хувилбар,
 * эхний 40 бараанд зураг. Зөвхөн ALLOW_TEST_SEED=1 үед. Байгаа кодыг алгасна.
 */
import { PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import { combos, variantCode } from '../lib/catalog/variants';
import { saveProductImage } from '../lib/storage';

if (process.env.ALLOW_TEST_SEED !== '1') {
  console.error('Татгалзлаа: ALLOW_TEST_SEED=1 тохируулаагүй байна.');
  process.exit(1);
}
const N = Number(process.env.SEED_PRODUCTS ?? 10000);
const CATS = ['Гутал', 'Хувцас', 'Гоо сайхан', 'Цүнх', 'Аксессуар', 'Гэр ахуй', 'Хүүхэд', 'Спорт', 'Электрон', 'Үнэт эдлэл', 'Хоол', 'Бусад'];
const COLORS_ = ['orange', 'blue', 'green', 'teal', 'violet', 'rose', 'amber', 'gray'];
const SEASONS = ['Хавар', 'Зун', 'Намар', 'Өвөл'];
const NOUNS = ['пүүз', 'гутал', 'цамц', 'өмд', 'ороолт', 'малгай', 'цүнх', 'тос', 'серум', 'маск', 'бээлий', 'хүрэм', 'даашинз', 'оймс', 'бүс'];
const ADJ = ['Цагаан', 'Хар', 'Кашемир', 'Арьсан', 'Ноосон', 'Хөнгөн', 'Дулаан', 'Спорт', 'Классик', 'Шинэ загварын'];
const COLORS = ['Хар', 'Цагаан', 'Саарал', 'Бор', 'Улаан', 'Цэнхэр'];
const SIZES = [['36', '37', '38', '39', '40'], ['S', 'M', 'L', 'XL'], ['38', '39', '40', '41', '42', '43']];

async function main() {
  const db = new PrismaClient();
  for (const [i, name] of CATS.entries()) await db.category.upsert({ where: { name }, update: {}, create: { name, color: COLORS_[i % COLORS_.length]!, sortOrder: i + 1 } });
  for (const [i, name] of SEASONS.entries()) await db.season.upsert({ where: { name }, update: {}, create: { name, sortOrder: i + 1 } });
  const cats = await db.category.findMany();
  const seasons = await db.season.findMany();
  const existing = new Set((await db.product.findMany({ select: { code: true } })).map((p) => p.code));

  let created = 0, variants = 0;
  const BATCH = 500;
  for (let start = 1; start <= N; start += BATCH) {
    const rows = [];
    for (let i = start; i < Math.min(start + BATCH, N + 1); i++) {
      const code = String(i).padStart(5, '0');
      if (existing.has(code)) continue;
      const kind = i % 4; // 0: хувилбаргүй, 1: өнгө, 2: хэмжээ, 3: өнгө×хэмжээ
      const colors = kind === 1 || kind === 3 ? COLORS.slice(0, 2 + (i % 3)) : [];
      const sizes = kind === 2 || kind === 3 ? SIZES[i % 3]! : [];
      rows.push({
        code, name: `${ADJ[i % ADJ.length]} ${NOUNS[i % NOUNS.length]} ${i}`, price: 10000 + (i % 50) * 5000,
        costPrice: 5000 + (i % 50) * 2500, categoryId: cats[i % cats.length]!.id, seasonId: i % 3 ? seasons[i % seasons.length]!.id : null,
        status: (i % 20 === 0 ? 'DISCONTINUED' : i % 33 === 0 ? 'ARCHIVED' : 'ACTIVE') as 'ACTIVE', colors, sizes,
      });
    }
    if (!rows.length) continue;
    await db.product.createMany({ data: rows, skipDuplicates: true });
    const ids = await db.product.findMany({ where: { code: { in: rows.map((r) => r.code) } }, select: { id: true, code: true, colors: true, sizes: true } });
    const vrows = ids.flatMap((p) => combos(p.colors, p.sizes).map((c, k) => ({ productId: p.id, code: variantCode(p.code, c), color: c.color, size: c.size, sortOrder: k })));
    await db.productVariant.createMany({ data: vrows, skipDuplicates: true });
    created += rows.length; variants += vrows.length;
    process.stdout.write(`\r${created} бараа, ${variants} хувилбар`);
  }
  // Цөөн бараанд жинхэнэ зураг (UI шалгахад)
  const withImg = await db.product.findMany({ where: { images: { none: {} } }, orderBy: { id: 'asc' }, take: 40, select: { id: true } });
  const palette = ['#E8590C', '#2563EB', '#15803D', '#7C3AED', '#0F766E', '#B45309', '#E11D48', '#16181D'];
  for (const [k, p] of withImg.entries()) {
    const buf = await sharp({ create: { width: 900, height: 900, channels: 3, background: palette[k % palette.length]! } }).jpeg().toBuffer();
    const saved = await saveProductImage(p.id, buf);
    await db.productImage.create({ data: { productId: p.id, isMain: true, sortOrder: 0, ...saved } });
  }
  console.log(`\nДууслаа: ${created} шинэ бараа, ${variants} хувилбар, ${withImg.length} зураг.`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
