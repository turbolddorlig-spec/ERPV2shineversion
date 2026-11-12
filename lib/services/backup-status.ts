import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Нөөц хуулбарын төлөв (#132): backup контейнер /backups/.status/status.json бичнэ, апп зөвхөн уншина.
 * Файл байхгүй (хөгжүүлэлт / тест) бол анхааруулахгүй.
 */
export interface BackupStatus {
  lastOk: string; lastFile: string; lastBytes: string; lastErrorAt: string; lastError: string; warning: string;
  driveConfigured: boolean; driveOkAt: string; driveErrorAt: string; driveError: string; driveUsedPct: string; checkedAt: string;
}
export interface BackupAlert { level: 'bad' | 'warn'; text: string }

export const BACKUP_STALE_MS = 26 * 3600_000;
const dir = () => process.env.BACKUP_STATUS_DIR ?? path.join(process.cwd(), 'data', 'backup-status');
const fmt = (iso: string) => new Date(iso).toLocaleString('mn-MN', { timeZone: 'Asia/Ulaanbaatar', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const t = (s: string) => (s ? Date.parse(s) || 0 : 0);

/** Төлөвөөс анхааруулга гаргана (цэвэр функц — тестлэгдэнэ) */
export function backupAlertOf(s: BackupStatus | null, now = Date.now()): BackupAlert[] {
  if (!s) return [];
  const out: BackupAlert[] = [];
  const ok = t(s.lastOk);
  if (t(s.lastErrorAt) > ok) out.push({ level: 'bad', text: `Нөөц хуулбар амжилтгүй (${fmt(s.lastErrorAt)}): ${s.lastError || 'алдаа'}${ok ? ` — сүүлийн амжилттай: ${fmt(s.lastOk)}` : ''}` });
  else if (!ok) {
    // Анх суулгаад эхний 03:00 хүртэл — контейнер асаад 26 цаг болоогүй бол анхааруулахгүй
    if (now - t(s.checkedAt) > BACKUP_STALE_MS) out.push({ level: 'bad', text: 'Нөөц хуулбар нэг ч удаа амжилттай авагдаагүй байна.' });
  } else if (now - ok > BACKUP_STALE_MS) out.push({ level: 'bad', text: `Нөөц хуулбар ${fmt(s.lastOk)}-аас хойш авагдаагүй байна.` });
  if (s.warning) out.push({ level: 'warn', text: s.warning });
  if (!s.driveConfigured) out.push({ level: 'warn', text: 'Google Drive холбогдоогүй — хуулбар зөвхөн сервер дээр байна (серверт ./setup-drive-backup.sh).' });
  else {
    if (t(s.driveErrorAt) > t(s.driveOkAt)) out.push({ level: 'warn', text: `Google Drive руу хуулж чадсангүй (${fmt(s.driveErrorAt)}): ${s.driveError || 'алдаа'}` });
    else if (ok && t(s.driveOkAt) && ok - t(s.driveOkAt) > 3600_000) out.push({ level: 'warn', text: `Google Drive-д сүүлд ${fmt(s.driveOkAt)}-нд хуулсан.` });
    const pct = Number(s.driveUsedPct);
    if (s.driveUsedPct && pct >= 80) out.push({ level: 'warn', text: `Google Drive ${pct}% дүүрсэн — 90% хүрвэл хамгийн хуучин сарын хуулбар автоматаар устна.` });
  }
  return out;
}

let cache: { at: number; v: BackupStatus | null } | null = null;
export async function readBackupStatus(): Promise<BackupStatus | null> {
  if (cache && Date.now() - cache.at < 60_000) return cache.v;
  let v: BackupStatus | null = null;
  try { v = JSON.parse(await readFile(path.join(dir(), 'status.json'), 'utf8')) as BackupStatus; } catch { v = null; }
  cache = { at: Date.now(), v };
  return v;
}
/** Зөвхөн Супер админд */
export async function backupAlert(roles: string[]): Promise<BackupAlert[] | null> {
  if (!roles.includes('SUPER_ADMIN')) return null;
  const a = backupAlertOf(await readBackupStatus());
  return a.length ? a : null;
}
export const _bustBackupCache = () => { cache = null; };
