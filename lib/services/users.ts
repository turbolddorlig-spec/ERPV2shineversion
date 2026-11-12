import { Prisma, type Role } from '@prisma/client';
import { db } from '../db';
import { writeAudit } from '../audit';
import { ALL_ROLES, isAdmin, isRole, manageableRoles } from '../roles';
import { isValidPhone, normalizePhone } from '../phone';
import { generateTempPassword, hashPassword, passwordProblem } from '../password';
import { revokeAllSessions } from '../session';
import { clearLoginThrottle } from './auth';
import { badRequest, conflict, forbidden, notFound } from '../errors';

export interface UserActor {
  id: string;
  name: string;
  roles: Role[];
  ip?: string | null;
}

export const PAGE_SIZE = 25;

const PUBLIC_SELECT = {
  id: true, phone: true, name: true, roles: true, isActive: true, mustChangePassword: true,
  lockedUntil: true, lastLoginAt: true, createdAt: true, updatedAt: true,
} satisfies Prisma.UserSelect;

export type PublicUser = Prisma.UserGetPayload<{ select: typeof PUBLIC_SELECT }>;

/** Тухайн хэрэглэгчийн бүх role-ийг actor удирдаж чадах уу */
export function canManage(actorRoles: Role[], targetRoles: Role[]): boolean {
  const m = new Set(manageableRoles(actorRoles));
  return targetRoles.length > 0 && targetRoles.every((r) => m.has(r));
}

function cleanRoles(input: unknown): Role[] {
  if (!Array.isArray(input)) throw badRequest('Role сонгоно уу');
  if (input.some((r) => !isRole(r))) throw badRequest('Буруу role байна');
  const roles = new Set(input as Role[]);
  if (roles.size === 0) throw badRequest('Дор хаяж нэг role сонгоно уу');
  return ALL_ROLES.filter((r) => roles.has(r));
}

function cleanName(input: unknown): string {
  const name = String(input ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 2) throw badRequest('Нэр дор хаяж 2 үсэг байх ёстой');
  if (name.length > 80) throw badRequest('Нэр хэт урт байна');
  return name;
}

function cleanPhone(input: unknown): string {
  const phone = normalizePhone(String(input ?? ''));
  if (!isValidPhone(phone)) throw badRequest('Утасны дугаар 8 оронтой байх ёстой');
  return phone;
}

function assertAssignable(actor: UserActor, roles: Role[]) {
  const allowed = new Set(manageableRoles(actor.roles));
  const bad = roles.filter((r) => !allowed.has(r));
  if (bad.length) throw forbidden('Та энэ role-ийг олгох эрхгүй');
}

async function loadManageable(actor: UserActor, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Хэрэглэгч олдсонгүй');
  const target = await db.user.findUnique({ where: { id } });
  if (!target) throw notFound('Хэрэглэгч олдсонгүй');
  if (!canManage(actor.roles, target.roles)) throw forbidden('Та энэ хэрэглэгчийг удирдах эрхгүй');
  return target;
}

async function assertNotLastSuperAdmin(targetId: string, tx: Prisma.TransactionClient) {
  const others = await tx.user.count({ where: { id: { not: targetId }, isActive: true, roles: { has: 'SUPER_ADMIN' } } });
  if (others === 0) throw badRequest('Сүүлийн идэвхтэй Супер админыг хааж/өөрчилж болохгүй');
}

function uniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

export interface ListParams {
  q?: string;
  role?: string;
  status?: 'active' | 'inactive' | 'locked' | 'all';
  page?: number;
}

export async function listUsers(actor: UserActor, params: ListParams) {
  const manageable = manageableRoles(actor.roles);
  if (manageable.length === 0) throw forbidden();
  const where: Prisma.UserWhereInput = {};
  const and: Prisma.UserWhereInput[] = [];

  // Админ бүх хэрэглэгчийг харна; ахлагч зөвхөн өөрийн багийг
  if (!isAdmin(actor.roles)) {
    const others = ALL_ROLES.filter((r) => !manageable.includes(r));
    and.push({ roles: { hasSome: manageable } }, { NOT: { roles: { hasSome: others } } });
  }
  const q = params.q?.trim();
  if (q) {
    const digits = q.replace(/\D/g, '');
    and.push({ OR: [{ name: { contains: q, mode: 'insensitive' } }, ...(digits.length >= 3 ? [{ phone: { contains: digits } }] : [])] });
  }
  if (params.role && isRole(params.role)) and.push({ roles: { has: params.role } });
  const status = params.status ?? 'active';
  if (status === 'active') and.push({ isActive: true });
  if (status === 'inactive') and.push({ isActive: false });
  if (status === 'locked') and.push({ lockedUntil: { gt: new Date() } });
  if (and.length) where.AND = and;

  const page = Math.max(1, Math.min(10000, Math.floor(params.page ?? 1)));
  const [total, items] = await Promise.all([
    db.user.count({ where }),
    db.user.findMany({ where, select: PUBLIC_SELECT, orderBy: [{ isActive: 'desc' }, { name: 'asc' }], skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
  ]);
  return {
    items: items.map((u) => ({ ...u, canManage: canManage(actor.roles, u.roles) && u.id !== actor.id })),
    total, page, pageSize: PAGE_SIZE,
  };
}

export interface CreateInput {
  phone: unknown;
  name: unknown;
  roles: unknown;
  password?: unknown;
}

/** Нууц үг өгөөгүй бол түр нууц үг үүсгэж, нэг л удаа буцаана */
export async function createUser(actor: UserActor, input: CreateInput) {
  const phone = cleanPhone(input.phone);
  const name = cleanName(input.name);
  const roles = cleanRoles(input.roles);
  assertAssignable(actor, roles);

  let password: string;
  let temporary = false;
  if (input.password === undefined || input.password === null || input.password === '') {
    password = generateTempPassword();
    temporary = true;
  } else {
    password = String(input.password);
    const p = passwordProblem(password);
    if (p) throw badRequest(p, 'weak_password');
  }
  const passwordHash = await hashPassword(password);

  try {
    const user = await db.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: { phone, name, roles, passwordHash, mustChangePassword: temporary, createdById: actor.id },
        select: PUBLIC_SELECT,
      });
      await writeAudit(actor, 'user.created', 'User', u.id, { phone, name, roles }, tx);
      return u;
    });
    return { user, temporaryPassword: temporary ? password : null };
  } catch (e) {
    if (uniqueViolation(e)) throw conflict('Энэ утасны дугаартай хэрэглэгч аль хэдийн бүртгэлтэй байна', 'phone_taken');
    throw e;
  }
}

export interface UpdateInput {
  phone?: unknown;
  name?: unknown;
  roles?: unknown;
}

export async function updateUser(actor: UserActor, id: string, input: UpdateInput) {
  if (id === actor.id && input.roles !== undefined) throw forbidden('Өөрийн role-ийг өөрөө өөрчилж болохгүй');
  const target = await loadManageable(actor, id);
  const data: Prisma.UserUpdateInput = {};
  const changes: Record<string, { from: unknown; to: unknown }> = {};

  if (input.name !== undefined) {
    const name = cleanName(input.name);
    if (name !== target.name) { data.name = name; changes.name = { from: target.name, to: name }; }
  }
  if (input.phone !== undefined) {
    const phone = cleanPhone(input.phone);
    if (phone !== target.phone) { data.phone = phone; changes.phone = { from: target.phone, to: phone }; }
  }
  if (input.roles !== undefined) {
    const roles = cleanRoles(input.roles);
    assertAssignable(actor, roles);
    const same = roles.length === target.roles.length && roles.every((r) => target.roles.includes(r));
    if (!same) { data.roles = { set: roles }; changes.roles = { from: target.roles, to: roles }; }
  }
  if (Object.keys(changes).length === 0) {
    return db.user.findUniqueOrThrow({ where: { id }, select: PUBLIC_SELECT });
  }
  try {
    return await db.$transaction(async (tx) => {
      if (changes.roles && target.roles.includes('SUPER_ADMIN') && !(data.roles as { set: Role[] }).set.includes('SUPER_ADMIN')) {
        await assertNotLastSuperAdmin(id, tx);
      }
      if (changes.roles && target.roles.includes('DRIVER') && !(data.roles as { set: Role[] }).set.includes('DRIVER')) await assertDriverClear(tx, id, target.name);
      const u = await tx.user.update({ where: { id }, data, select: PUBLIC_SELECT });
      await writeAudit(actor, 'user.updated', 'User', id, changes as Prisma.InputJsonValue, tx);
      return u;
    });
  } catch (e) {
    if (uniqueViolation(e)) throw conflict('Энэ утасны дугаартай хэрэглэгч аль хэдийн бүртгэлтэй байна', 'phone_taken');
    throw e;
  }
}

/** Жолоочийн гарт бараа / хүргэлтэд гарсан, хуваарилагдсан захиалга байгаа эсэх (#124-З) — байвал эрхийг хасахгүй */
async function assertDriverClear(tx: Prisma.TransactionClient | typeof db, id: string, name: string) {
  const [goods, orders] = await Promise.all([
    tx.$queryRaw<{ n: number }[]>`SELECT COALESCE(sum(b.qty), 0)::int AS n FROM "StockBalance" b JOIN "StockLocation" l ON l.id = b."locationId" AND l.kind = 'DRIVER' AND l."userId" = ${id}::uuid`,
    tx.order.count({ where: { driverId: id, status: { in: ['ASSIGNED', 'OUT_FOR_DELIVERY'] } } }),
  ]);
  const g = goods[0]?.n ?? 0;
  if (g > 0 || orders > 0) throw conflict(`${name}-ийн гарт ${g} бараа, ${orders} захиалга байна — эхлээд буцааж авна уу (агуулахын буцаалт / ахлах жолооч)`, 'driver_has_goods');
}

export async function deactivateUser(actor: UserActor, id: string) {
  if (id === actor.id) throw badRequest('Өөрийн эрхийг өөрөө хааж болохгүй');
  const target = await loadManageable(actor, id);
  if (!target.isActive) return { ...(await db.user.findUniqueOrThrow({ where: { id }, select: PUBLIC_SELECT })), warning: null as string | null };
  return db.$transaction(async (tx) => {
    if (target.roles.includes('SUPER_ADMIN')) await assertNotLastSuperAdmin(id, tx);
    if (target.roles.includes('DRIVER')) await assertDriverClear(tx, id, target.name);
    const u = await tx.user.update({ where: { id }, data: { isActive: false }, select: PUBLIC_SELECT });
    const n = await revokeAllSessions(id, tx);
    // Аудит Б18: нээлттэй зээл, өр, хасагдаагүй торгууль байвал анхааруулна (цалингийн / тооцооны самбарт үлдэнэ)
    const [loans, debts, pens, cdebt] = await Promise.all([
      tx.staffLoan.count({ where: { staffId: id, status: 'ISSUED' } }),
      tx.staffDebt.count({ where: { staffKey: `u:${id}`, isActive: true } }),
      tx.penalty.count({ where: { userId: id, status: 'ACTIVE', deducted: false } }),
      tx.companyDebt.count({ where: { driverId: id, status: 'PENDING' } }),
    ]);
    const open = [loans ? `${loans} зээл` : '', debts ? `${debts} өр` : '', pens ? `${pens} торгууль` : '', cdebt ? `${cdebt} жолоочийн өр` : ''].filter(Boolean);
    await writeAudit(actor, 'user.deactivated', 'User', id, { sessionsClosed: n, ...(open.length ? { open } : {}) }, tx);
    return { ...u, warning: open.length ? `${u.name}-д дуусаагүй ${open.join(', ')} байна — цалин / тооцооны самбарт «Идэвхгүй» гэж үлдэнэ, тэндээс хааж дуусгана уу.` : null };
  });
}

export async function activateUser(actor: UserActor, id: string) {
  const target = await loadManageable(actor, id);
  if (target.isActive) return db.user.findUniqueOrThrow({ where: { id }, select: PUBLIC_SELECT });
  return db.$transaction(async (tx) => {
    const u = await tx.user.update({ where: { id }, data: { isActive: true, failedLoginCount: 0, lockedUntil: null }, select: PUBLIC_SELECT });
    await writeAudit(actor, 'user.activated', 'User', id, undefined, tx);
    return u;
  });
}

/** Түр нууц үг олгоно: хэрэглэгч анх нэвтрэхдээ солих ёстой, бүх төхөөрөмжөөс гарна (шийдвэр #16) */
export async function resetPassword(actor: UserActor, id: string) {
  if (id === actor.id) throw badRequest('Өөрийн нууц үгийг "Миний мэдээлэл" хэсгээс солино уу');
  await loadManageable(actor, id);
  const temporaryPassword = generateTempPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id },
      data: { passwordHash, mustChangePassword: true, failedLoginCount: 0, lockedUntil: null, passwordChangedAt: new Date() },
    });
    const n = await revokeAllSessions(id, tx);
    await writeAudit(actor, 'user.password_reset', 'User', id, { sessionsClosed: n }, tx);
  });
  clearLoginThrottle(id);
  return { temporaryPassword };
}

/** Түгжээг гараар тайлах — зөвхөн админ (шийдвэр #17) */
export async function unlockUser(actor: UserActor, id: string) {
  if (!isAdmin(actor.roles)) throw forbidden('Түгжээг зөвхөн админ тайлна');
  await loadManageable(actor, id);
  return db.$transaction(async (tx) => {
    const u = await tx.user.update({ where: { id }, data: { failedLoginCount: 0, lockedUntil: null }, select: PUBLIC_SELECT });
    await writeAudit(actor, 'user.unlocked', 'User', id, undefined, tx);
    clearLoginThrottle(id);
    return u;
  });
}

/** Хэрэглэгчтэй холбоотой түүх: түүн дээр хийсэн болон түүний хийсэн үйлдлүүд */
export async function userHistory(actor: UserActor, id: string, page = 1) {
  if (id !== actor.id) await loadManageable(actor, id);
  const take = 50;
  const where: Prisma.AuditLogWhereInput = { OR: [{ entityType: 'User', entityId: id }, { actorId: id }] };
  const items = await db.auditLog.findMany({ where, orderBy: { id: 'desc' }, skip: (Math.max(1, page) - 1) * take, take });
  return { items: items.map((i) => ({ ...i, id: i.id.toString() })), page };
}
