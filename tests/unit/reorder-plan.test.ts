import { describe, expect, it } from 'vitest';
import { planOf } from '@/lib/services/outflow';

const cfg = { leadDays: 15, coverDays: 30 };
describe('#205 дахин татах төлөвлөгөө (planOf)', () => {
  it('эзний жишээ: хурд 20, одоо 60, 12/5-нд 200 ирнэ → 12/1-нд дуусч 4 хоног тасарна, 12/15 хүртэл, 11/30-нд ~600 татах', () => {
    const p = planOf(60, 20, [{ day: '2026-12-05', qty: 200 }], cfg, '2026-11-28')!;
    expect(p).toMatchObject({ gapFrom: '2026-12-01', gapDays: 4, coverUntil: '2026-12-15', nextOrderDay: '2026-11-30', suggestQty: 600, again: false });
    // 11/30 болоход «дахин татах»
    expect(planOf(20, 20, [{ day: '2026-12-05', qty: 200 }], cfg, '2026-11-30')!.again).toBe(true);
  });
  it('хангалттай нөөцтэй бол тасрахгүй; хэд хэдэн ачаа нийлнэ; хоцорсон ачааг өнөөдөр ирнэ гэж үзнэ', () => {
    const p = planOf(300, 10, [{ day: '2026-12-10', qty: 100 }, { day: '2026-12-20', qty: 100 }], cfg, '2026-12-01')!;
    expect([p.gapDays, p.coverUntil, p.incoming.length]).toEqual([0, '2027-01-20', 2]);
    expect(planOf(0, 10, [{ day: '2026-11-20', qty: 50 }], cfg, '2026-12-01')!).toMatchObject({ gapDays: 0, coverUntil: '2026-12-06' });
  });
  it('хурдгүй / захиалгагүй', () => {
    expect(planOf(10, 0, [{ day: '2026-12-05', qty: 5 }], cfg, '2026-12-01')).toMatchObject({ coverUntil: null, nextOrderDay: null, again: false, suggestQty: 0 });
    expect(planOf(10, 5, [], cfg, '2026-12-01')).toBeNull();
  });
});
