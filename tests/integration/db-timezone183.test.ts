import { beforeAll, describe, expect, it } from 'vitest';

/** #183 Database-ийн сессийн цагийн бүс UTC байх ёстой (огноо UTC-ээр хадгалагддаг) — эс бөгөөс raw SQL-ийн «өнөөдөр» 8 цагаар зөрнө */
let db: typeof import('@/lib/db').db;
beforeAll(async () => { db = (await import('@/lib/db')).db; });
describe('#183 database цагийн бүс', () => {
  it('сесс UTC; «өнөөдрийн эхлэл»-тэй raw харьцуулалт зөв', async () => {
    const [tz] = await db.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`;
    expect(tz?.tz).toBe('UTC');
    const ub = await import('@/lib/ubdate');
    const start = ub.ubDayStart(ub.ubDay());
    // UTC-ээр хадгалсан «одоо» нь өнөөдрийн эхлэлээс хойш байх ёстой
    const [r] = await db.$queryRaw<{ ok: boolean }[]>`SELECT (now() AT TIME ZONE 'UTC')::timestamp >= ${start} AS ok`;
    expect(r?.ok).toBe(true);
  });
});
