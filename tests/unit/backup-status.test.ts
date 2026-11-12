import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { backupAlertOf, backupAlert, BACKUP_STALE_MS, _bustBackupCache, type BackupStatus } from '@/lib/services/backup-status';

/** #132: нөөц хуулбарын төлөв → Супер админы анхааруулга */
const NOW = Date.parse('2026-11-12T05:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const base = (o: Partial<BackupStatus> = {}): BackupStatus => ({
  lastOk: iso(NOW - 3600_000), lastFile: 'erp-x.sql.gz', lastBytes: '130000000', lastErrorAt: '', lastError: '', warning: '',
  driveConfigured: true, driveOkAt: iso(NOW - 3600_000 + 5000), driveErrorAt: '', driveError: '', driveUsedPct: '20', checkedAt: iso(NOW - 3600_000), ...o,
});

describe('backupAlertOf', () => {
  it('файлгүй (хөгжүүлэлт) — анхааруулгагүй; бүх зүйл хэвийн — анхааруулгагүй', () => {
    expect(backupAlertOf(null, NOW)).toEqual([]);
    expect(backupAlertOf(base(), NOW)).toEqual([]);
  });
  it('26+ цаг хуулбаргүй → улаан', () => {
    const a = backupAlertOf(base({ lastOk: iso(NOW - BACKUP_STALE_MS - 1000), driveOkAt: iso(NOW - BACKUP_STALE_MS) }), NOW);
    expect(a[0]?.level).toBe('bad');
    expect(a[0]?.text).toContain('авагдаагүй');
  });
  it('сүүлийн оролдлого амжилтгүй → улаан + алдааны текст; хуучин алдаа (амжилтын өмнөх) → гарахгүй', () => {
    const bad = backupAlertOf(base({ lastErrorAt: iso(NOW - 60_000), lastError: 'pg_dump амжилтгүй' }), NOW);
    expect(bad[0]).toMatchObject({ level: 'bad' });
    expect(bad[0]?.text).toContain('pg_dump амжилтгүй');
    expect(backupAlertOf(base({ lastErrorAt: iso(NOW - 7200_000), lastError: 'хуучин' }), NOW)).toEqual([]);
  });
  it('анх суулгаад эхний хуулбар хүртэл (26 цаг) — анхааруулахгүй, түүнээс хойш улаан', () => {
    expect(backupAlertOf(base({ lastOk: '', driveOkAt: '', checkedAt: iso(NOW - 3600_000) }), NOW).filter((a) => a.level === 'bad')).toEqual([]);
    expect(backupAlertOf(base({ lastOk: '', driveOkAt: '', checkedAt: iso(NOW - BACKUP_STALE_MS - 1) }), NOW)[0]?.level).toBe('bad');
  });
  it('Drive холбогдоогүй / алдаа / 80%+ дүүрсэн → шар', () => {
    expect(backupAlertOf(base({ driveConfigured: false }), NOW)).toEqual([expect.objectContaining({ level: 'warn', text: expect.stringContaining('Google Drive холбогдоогүй') })]);
    expect(backupAlertOf(base({ driveErrorAt: iso(NOW - 1000), driveError: 'token expired' }), NOW)[0]?.text).toContain('token expired');
    expect(backupAlertOf(base({ driveUsedPct: '85' }), NOW)[0]?.text).toContain('85%');
    expect(backupAlertOf(base({ warning: 'Хуулбарын хэмжээ огцом багассан' }), NOW)[0]?.level).toBe('warn');
  });
  it('зөвхөн Супер админд; status.json файлыг уншина', async () => {
    const d = await mkdtemp(path.join(tmpdir(), 'bk-'));
    process.env.BACKUP_STATUS_DIR = d;
    await writeFile(path.join(d, 'status.json'), JSON.stringify(base({ lastOk: iso(Date.now() - BACKUP_STALE_MS - 60_000), checkedAt: iso(Date.now()) })));
    _bustBackupCache();
    expect(await backupAlert(['ADMIN'])).toBeNull();
    expect((await backupAlert(['SUPER_ADMIN']))?.[0]?.level).toBe('bad');
    delete process.env.BACKUP_STATUS_DIR;
  });
});
