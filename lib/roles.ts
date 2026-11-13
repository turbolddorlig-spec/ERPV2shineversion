import type { Role } from '@prisma/client';

export const ALL_ROLES: Role[] = [
  'SUPER_ADMIN', 'ADMIN', 'OPERATOR_LEAD', 'OPERATOR', 'DRIVER_LEAD', 'DRIVER',
  'ACCOUNTING', 'WAREHOUSE', 'MARKETING_LEAD', 'MARKETING', 'PENALTY_OFFICER', 'SUPPLIER',
];

export const ROLE_LABEL: Record<Role, string> = {
  SUPER_ADMIN: 'Супер админ',
  ADMIN: 'Админ',
  OPERATOR_LEAD: 'Ахлах оператор',
  OPERATOR: 'Оператор',
  DRIVER_LEAD: 'Ахлах жолооч',
  DRIVER: 'Жолооч',
  ACCOUNTING: 'Нягтлан',
  WAREHOUSE: 'Агуулах',
  MARKETING_LEAD: 'Ахлах маркетинг',
  MARKETING: 'Маркетинг',
  PENALTY_OFFICER: 'Торгуулийн ажилтан',
  SUPPLIER: 'Нийлүүлэгч',
};

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ALL_ROLES as string[]).includes(v);
}

/**
 * Хэн ямар role-тэй хэрэглэгчийг үүсгэж, засаж, хааж болох вэ (шийдвэр #19).
 * Олон role-тэй бол нийлбэр нь.
 */
const MANAGES: Partial<Record<Role, Role[]>> = {
  SUPER_ADMIN: ALL_ROLES,
  // Аудит #155 (эзний шийдвэр): админ данс (нууц үг, идэвх, админ болгох)-ыг зөвхөн Супер админ удирдана
  ADMIN: ALL_ROLES.filter((r) => r !== 'SUPER_ADMIN' && r !== 'ADMIN'),
  OPERATOR_LEAD: ['OPERATOR'],
  DRIVER_LEAD: ['DRIVER'],
  MARKETING_LEAD: ['MARKETING'],
};

export function manageableRoles(actorRoles: Role[]): Role[] {
  const set = new Set<Role>();
  for (const r of actorRoles) for (const m of MANAGES[r] ?? []) set.add(m);
  return ALL_ROLES.filter((r) => set.has(r));
}

export function isAdmin(roles: Role[]): boolean {
  return roles.includes('SUPER_ADMIN') || roles.includes('ADMIN');
}
