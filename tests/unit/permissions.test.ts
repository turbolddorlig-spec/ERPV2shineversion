import { describe, expect, it } from 'vitest';
import type { Role } from '@prisma/client';
import { accessTo, homeFor, PAGES, visiblePages, type PageKey } from '@/lib/permissions';
import { ALL_ROLES, manageableRoles } from '@/lib/roles';

// Эзний баталсан хүснэгт (MODULE0_PLAN.html). E = ажиллана, V = зөвхөн харна, - = хандахгүй
// Багана: SA A OL OP DL DR ACC WH ML MK PEN SUP
const MATRIX: Record<PageKey, string> = {
  dashboard:      'E E - - - - - - - - - -',
  orders:         'E E E E - - - - - - V -',
  'bank-import':  'E E E V - - E - - - - -', // #82 5: хуучин шиг + нягтлан; оператор харна
  products:       'E E - - - - - E E E V -',
  'goods-outflow':'E E - - - - - - E E - -',
  warehouse:      'E E - - - - V E - - - -',
  loans:          'E E E E E - E E E E - -', // #149: ахлах жолооч зээлнэ
  reports:        'E - - - - - - - E E - -',
  handover:       'E E - - - - V E - - - -',
  'driver-lead':  'E E - - E - - - - - - -',
  driver:         '- - - - - E - - - - - -',
  // Модуль 5 (#74): Жолоочийн хяналт — SA, A, ахлах жолооч; нягтлан, агуулах харна
  'driver-control': 'E E - - E - V V - - - -',
  issues:         'E E E E - - - - - - V -',
  accounting:     'E E - - - - E - - - - -',
  penalties:      'E E E - - - E - - - E -',
  salary:         'E E - - - - E - - - - -',
  'my-penalties': 'E E E E E E E E E E E -',
  supplier:       'E E - - - - - - - - - V', // #96: хуучин шиг Супер админ, Админ
  users:          'E E E - E - - - E - - -',
  settings:       'E E - - - - - - - - - -',
  'product-history': 'E E - - - - - V E V V -',
};
const COLS: Role[] = ['SUPER_ADMIN', 'ADMIN', 'OPERATOR_LEAD', 'OPERATOR', 'DRIVER_LEAD', 'DRIVER', 'ACCOUNTING', 'WAREHOUSE', 'MARKETING_LEAD', 'MARKETING', 'PENALTY_OFFICER', 'SUPPLIER'];
const SYM = { E: 'edit', V: 'view', '-': 'none' } as const;

describe('эрхийн хүснэгт', () => {
  it('бүх 18 хуудас хүснэгтэд байна', () => {
    expect(PAGES.map((p) => p.key).sort()).toEqual(Object.keys(MATRIX).sort());
  });
  for (const [page, row] of Object.entries(MATRIX)) {
    const cells = row.split(/\s+/);
    COLS.forEach((role, i) => {
      it(`${page} × ${role} = ${SYM[cells[i] as keyof typeof SYM]}`, () => {
        expect(accessTo([role], page as PageKey)).toBe(SYM[cells[i] as keyof typeof SYM]);
      });
    });
  }
  it('олон role → эрх нийлнэ (Маркетинг + Агуулах)', () => {
    expect(accessTo(['MARKETING', 'WAREHOUSE'], 'warehouse')).toBe('edit');
    expect(accessTo(['MARKETING', 'WAREHOUSE'], 'goods-outflow')).toBe('edit');
    expect(accessTo(['MARKETING'], 'warehouse')).toBe('none');
  });
  it('олон role → хамгийн өндөр эрх (Нягтлан харах + Агуулах засах)', () => {
    expect(accessTo(['ACCOUNTING', 'WAREHOUSE'], 'handover')).toBe('edit');
  });
  it('Ахлах жолооч + Агуулах → падаан хийж чадна', () => {
    const keys = visiblePages(['DRIVER_LEAD', 'WAREHOUSE']).map((p) => p.key);
    expect(keys).toContain('handover');
    expect(keys).toContain('driver-lead');
  });
  it('role бүр нүүр хуудастай', () => {
    for (const r of ALL_ROLES) expect(homeFor([r])).toMatch(/^\//);
    expect(homeFor(['DRIVER'])).toBe('/driver');
    expect(homeFor(['SUPPLIER'])).toBe('/supplier');
  });
});

describe('хэн хэнийг удирдах вэ (шийдвэр #19)', () => {
  it('Супер админ — бүгдийг', () => expect(manageableRoles(['SUPER_ADMIN'])).toEqual(ALL_ROLES));
  it('Админ — Супер админ, админаас бусдыг (#155)', () => { expect(manageableRoles(['ADMIN'])).not.toContain('SUPER_ADMIN'); expect(manageableRoles(['ADMIN'])).not.toContain('ADMIN'); });
  it('Ахлах оператор — зөвхөн Оператор', () => expect(manageableRoles(['OPERATOR_LEAD'])).toEqual(['OPERATOR']));
  it('Ахлах жолооч — зөвхөн Жолооч', () => expect(manageableRoles(['DRIVER_LEAD'])).toEqual(['DRIVER']));
  it('Ахлах маркетинг — зөвхөн Маркетинг', () => expect(manageableRoles(['MARKETING_LEAD'])).toEqual(['MARKETING']));
  it('Энгийн ажилтан — хэнийг ч үгүй', () => {
    for (const r of ['OPERATOR', 'DRIVER', 'ACCOUNTING', 'WAREHOUSE', 'MARKETING', 'PENALTY_OFFICER', 'SUPPLIER'] as Role[]) {
      expect(manageableRoles([r])).toEqual([]);
    }
  });
});
