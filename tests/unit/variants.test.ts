import { describe, expect, it } from 'vitest';
import { cleanAxis, cleanProductCode, combos, reasonProblem, suggestNextCode, variantCode, variantLabel } from '@/lib/catalog/variants';

describe('хувилбар', () => {
  it('тэнхлэг цэвэрлэнэ: хоосон, давхардал (том/жижиг үсэг), зай', () => {
    expect(cleanAxis([' Хар ', 'хар', '', 'Цагаан  саарал', null])).toEqual(['Хар', 'Цагаан саарал']);
    expect(cleanAxis('буруу')).toEqual([]);
  });
  it('хослол', () => {
    expect(combos([], [])).toEqual([{ color: '', size: '' }]);
    expect(combos(['Хар'], [])).toEqual([{ color: 'Хар', size: '' }]);
    expect(combos(['Хар', 'Цагаан'], ['38'])).toHaveLength(2);
  });
  it('код ба нэр', () => {
    expect(variantCode('0887', { color: 'Хар цагаан', size: '38/39' })).toBe('0887-ХАР_ЦАГААН-38/39');
    expect(variantCode('0412', { color: '', size: '' })).toBe('0412');
    expect(variantLabel({ color: 'Хар', size: '38' })).toBe('Хар · 38');
    expect(variantLabel({ color: '', size: '' })).toBe('Үндсэн');
  });
  it('барааны код', () => {
    expect(cleanProductCode(' ab12 ')).toBe('AB12');
    expect(cleanProductCode('a b')).toBeNull();
    expect(cleanProductCode('')).toBeNull();
  });
  it('дараагийн код урттайгаа', () => {
    expect(suggestNextCode(['0887', '0012', 'AB1'])).toBe('0888');
    expect(suggestNextCode([])).toBe('0001');
    expect(suggestNextCode(['9999'])).toBe('10000');
  });
  it('тайлбар: зайг тооцохгүй дор хаяж 5 тэмдэгт', () => {
    expect(reasonProblem('')).toMatch(/тайлбар/);
    expect(reasonProblem('аа бб')).toMatch(/тайлбар/);
    expect(reasonProblem('Үнэ өссөн')).toBeNull();
    expect(reasonProblem(undefined)).toMatch(/тайлбар/);
  });
});
