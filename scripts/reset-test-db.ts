/** ЗӨВХӨН ТЕСТИЙН database-ийг бүрэн цэвэрлэнэ (seed-ийн өмнө). ALLOW_TEST_SEED=1 ба DATABASE_URL-д "test" заавал. */
import { PrismaClient } from '@prisma/client';
import { resetDb } from './lib/test-db';

if (process.env.ALLOW_TEST_SEED !== '1' || !/test/.test(process.env.DATABASE_URL ?? '')) {
  console.error('Татгалзлаа: зөвхөн тест database (ALLOW_TEST_SEED=1, нэрэнд "test").');
  process.exit(1);
}
const db = new PrismaClient();
resetDb(db).then(() => { console.log('Тест database цэвэрлэгдлээ.'); return db.$disconnect(); }).catch((e) => { console.error(e); process.exit(1); });
