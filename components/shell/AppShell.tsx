'use client';
import clsx from 'clsx';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Icon } from '../icons';
import { ThemeToggle } from './ThemeToggle';
import { buildTree, moduleColor, SUB_LABEL } from './navTree';

export interface NavItem {
  key: string; label: string; short: string; href: string; group: string; icon: string; readOnly: boolean; badge?: number;
}

function initials(name: string) {
  return name.split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

function Logo({ small }: { small?: boolean }) {
  return (
    <span className={clsx('font-extrabold tracking-[-0.03em]', small ? 'text-[19px]' : 'text-[22px]')}>
      zahialga<span className="text-accent">•</span>
    </span>
  );
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
  // Захиалгын ноорог дараагийн хэрэглэгчид харагдахгүй
  try { localStorage.removeItem('zahialga:orderDraft:v1'); } catch { /* ignore */ }
  window.location.href = '/login';
}

export interface StockAlert { kind: 'mismatch' | 'stale'; count: number; at: string | null; since: string | null }
const ubTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString('mn-MN', { timeZone: 'Asia/Ulaanbaatar', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');

export function AppShell({ user, nav, alert, boostAlert, reorderAlert, reorderHref, assignAlert, handoverAlert, paidCancelAlert, staleGoodsAlert, jobsAlert, shortageSkip, backupAlert, smsAlert, children }: { user: { name: string; roleLabels: string[] }; nav: NavItem[]; alert?: StockAlert | null; boostAlert?: { red: number; orange: number } | null; reorderAlert?: { urgent: number; order: number; late: number } | null; reorderHref?: string; assignAlert?: { today: number; leftover: number; late: boolean; hour: number } | null; handoverAlert?: { count: number } | null; paidCancelAlert?: { count: number } | null; staleGoodsAlert?: { drivers: number; qty: number; amount: number; days: number } | null; jobsAlert?: { at: string } | null; shortageSkip?: { date: string; at: string } | null; backupAlert?: { level: 'bad' | 'warn'; text: string }[] | null; smsAlert?: { count: number; error: string | null } | null; children: ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);
  // Хамгийн тохирох (урт) замыг идэвхтэй гэж үзнэ: /products/history → "Барааны засвар", /products/5 → "Бараа"
  const best = nav.filter((n) => pathname === n.href || pathname.startsWith(n.href + '/')).sort((a, b) => b.href.length - a.href.length)[0]?.href;
  const active = (href: string) => href === best;
  const current = nav.find((n) => active(n.href));
  const tree = buildTree(nav);
  // Өргөн цэс (анх) / нарийн — хэрэглэгч бүрийн төхөөрөмж дээр санана
  const [userSlim, setUserSlim] = useState(false);
  useEffect(() => { try { setUserSlim(localStorage.getItem('zahialga:nav:slim') === '1'); } catch { /* ignore */ } }, []);
  // Өргөн хүснэгттэй хуудсанд (Барааны гарц) цэс автоматаар нарийн — хүснэгт багтана; «»»-оор түр өргөсгөнө
  const wideTable = pathname.startsWith('/goods-outflow');
  const [wideHere, setWideHere] = useState(false);
  useEffect(() => setWideHere(false), [pathname]);
  const slim = wideTable ? !wideHere : userSlim;
  const toggleSlim = () => {
    if (wideTable) { setWideHere(!wideHere); return; }
    const v = !userSlim; setUserSlim(v); try { localStorage.setItem('zahialga:nav:slim', v ? '1' : '0'); } catch { /* ignore */ }
  };
  const nodeActive = (n: { href: string; item: NavItem | null; children: NavItem[] }) => (n.item ? active(n.item.href) : false) || n.children.some((c) => active(c.href));
  const badgeEl = (b: number, small = false) => b ? <span className={clsx('rounded-full bg-[#E8590C] font-bold text-white', small ? 'min-w-[16px] px-1 text-center text-[10px] leading-[16px]' : 'min-w-[18px] px-1 text-center text-[10.5px] leading-[18px]')}>{b > 99 ? '99+' : b}</span> : null;

  // Анхааруулгууд (эзний хүсэлт #165): мөр мөрөөр биш — хонхны дүрс + тоо, дарахад жагсаалт
  const alerts: AlertItem[] = [];
  if (jobsAlert) alerts.push({ key: 'jobs', level: 'bad', icon: '⛔', text: `Автомат ажил (захиалга цуцлах, Meta, шөнийн өр, Gmail, тулгалт) ${ubTime(jobsAlert.at)}-аас хойш ажиллаагүй байна — серверийг шалгуулна уу.` });
  for (const [i, a] of (backupAlert ?? []).entries()) alerts.push({ key: `backup${i}`, level: a.level, icon: a.level === 'bad' ? '⛔' : '⚠️', text: a.text, ...(a.text.includes('Drive') ? { href: '/settings#drive', link: 'Нөөц хуулбарын тохиргоо' } : {}) });
  if (shortageSkip) alerts.push({ key: 'shortage', level: 'warn', icon: '⚠️', href: '/accounting', link: 'Тооцоо', text: `${shortageSkip.date}-ны жолоочийн дутуу барааны автомат өр хоцорсон (${ubTime(shortageSkip.at)}) тул бичигдсэнгүй — Тооцоо → Өр хэсэгт жолооч бүрээр шалгаж, шаардлагатай бол «Одоо хаах»-аар бодно уу.` });
  if (alert) alerts.push({ key: 'stock', level: 'bad', icon: '⚠', href: '/warehouse', link: 'Агуулах', text: alert.kind === 'mismatch'
    ? `Үлдэгдлийн тулгалтад ${alert.count} зөрүү илэрлээ (журнал ≠ үлдэгдэл)${alert.since ? ` · ${ubTime(alert.since)}-аас` : ''}. Агуулах руу орж шалгана уу.`
    : `Цаг тутмын автомат тулгалт ${ubTime(alert.at)}-аас хойш ажиллаагүй байна. Агуулах → «Дахин шалгах».` });
  if (boostAlert) alerts.push({ key: 'boost', level: boostAlert.red ? 'bad' : 'warn', icon: boostAlert.red ? '🔴' : '🟠', href: boostAlert.red ? '/goods-outflow?tab=red' : '/goods-outflow?tab=orange', link: 'Барааны гарц',
    text: `${boostAlert.red ? `Алдагдалтай бүүст: ${boostAlert.red} бараа — яаралтай шалгаж унтраана уу.` : ''}${boostAlert.orange ? ` Ашиг багассан / өсөлтгүй бүүст: ${boostAlert.orange} бараа.` : ''}`.trim() });
  if (assignAlert) alerts.push({ key: 'assign', level: 'bad', icon: '🔴', href: '/driver-lead', link: 'Хуваарилалт',
    text: `${assignAlert.leftover ? `Хоносон, хуваарилагдаагүй ${assignAlert.leftover} захиалга байна — яаралтай хуваарилна уу.` : ''}${assignAlert.late && assignAlert.today ? ` ${String(assignAlert.hour).padStart(2, '0')}:00 болсон — өнөөдрийн ${assignAlert.today} «Шинэ» захиалга хуваарилагдаагүй байна.` : ''}`.trim() });
  if (handoverAlert) alerts.push({ key: 'handover', level: 'bad', icon: '🔴', href: '/handover', link: 'Падаан', text: `Агуулах өгсөн боловч жолооч 2 цагаас удаан хүлээн аваагүй ${handoverAlert.count} падаан байна — бараа жолоочийн гарт, захиалга хүргэлтэд гараагүй.` });
  if (staleGoodsAlert) alerts.push({ key: 'stale-goods', level: 'bad', icon: '📦', href: '/accounting', link: 'Нягтлан', text: `${staleGoodsAlert.drivers} жолооч ${staleGoodsAlert.days}+ хоног бараагаа агуулахад өгөөгүй — ${staleGoodsAlert.qty} ширхэг, ${staleGoodsAlert.amount.toLocaleString('en-US')}₮ (өр хүлээгдэж байна).` });
  if (paidCancelAlert) alerts.push({ key: 'paid-cancel', level: 'warn', icon: '💰', href: '/bank-import?tab=paidCancelled', link: 'Жагсаалт', text: `Төлбөр орсон боловч жолооч / асуудлаар цуцлагдсан ${paidCancelAlert.count} захиалга байна — мөнгө нь захиалгадаа наалдсан чигтээ. Шалтгааныг тогтооно уу.` });
  if (reorderAlert) alerts.push({ key: 'reorder', level: reorderAlert.urgent || reorderAlert.late ? 'bad' : 'warn', icon: '🚚', href: reorderHref ?? '/goods-outflow?tab=reorder', link: reorderHref === '/supplier' ? 'Миний барааны гарц' : reorderHref === '/reorder' ? 'Бараа татах' : 'Барааны гарц',
    text: `Бараа их гарч байна, дуусах дөхлөө — бараагаа татаарай:${reorderAlert.urgent ? ` 🔴 яаралтай ${reorderAlert.urgent}` : ''}${reorderAlert.order ? ` 🟠 татах ${reorderAlert.order}` : ''}${reorderAlert.late ? ` ⏰ ирэх хугацаа хэтэрсэн ${reorderAlert.late}` : ''} бараа.` });
  if (smsAlert) alerts.push({ key: 'sms', level: 'bad', icon: '✉️', href: '/settings#sms', link: 'SMS тохиргоо', text: `Сүүлийн 24 цагт ${smsAlert.count} SMS явсангүй${smsAlert.error ? ` — ${smsAlert.error}` : ''}. Үлдэгдэл, түлхүүрээ шалгана уу.` });
  const [bellOpen, setBellOpen] = useState(false);
  useEffect(() => setBellOpen(false), [pathname]);

  const tint = (key: string) => ({ ['--nav-c']: moduleColor(key) }) as CSSProperties;

  return (
    <div className="min-h-screen" data-module-page={current?.key ?? ''} style={{ ['--page']: moduleColor(current?.key) } as CSSProperties}>
      {/* Компьютер, том таблет: зүүн цэс — өргөн (бүтэцтэй, #130) эсвэл нарийн (хуучин rail) */}
      <nav aria-label="Үндсэн цэс" data-nav={slim ? 'slim' : 'wide'} className={clsx('fixed inset-y-0 left-0 z-30 hidden flex-col gap-0.5 overflow-y-auto bg-rail py-3.5 lg:flex', slim ? 'w-[84px] px-2' : 'w-[204px] px-2.5')}>
        <div className={clsx('mb-3 flex items-center', slim ? 'flex-col gap-2' : 'justify-between pl-1')}>
          <Link href="/" aria-label="Нүүр" className="grid h-11 w-11 place-items-center rounded-[13px] bg-[#E8590C] text-[22px] font-extrabold tracking-[-0.04em] text-white">
            z<span className="text-[#16181D]">.</span>
          </Link>
          <div className={clsx('flex items-center gap-1', slim && 'flex-col')}>
            <AlertBell items={alerts} open={bellOpen} setOpen={setBellOpen} dark />
            <button type="button" onClick={toggleSlim} aria-label={slim ? 'Цэсийг өргөн болгох' : 'Цэсийг нарийн болгох'} title={slim ? 'Өргөн цэс' : 'Нарийн цэс'}
              className="grid h-8 w-8 place-items-center rounded-lg text-[15px] font-bold text-rail-text hover:bg-rail-active hover:text-white">{slim ? '»' : '«'}</button>
          </div>
        </div>
        {slim ? nav.map((n) => (
          <Link key={n.key} href={n.href} aria-current={active(n.href) ? 'page' : undefined} title={n.label}
            className={clsx('relative flex min-h-[58px] flex-col items-center justify-center gap-1 rounded-xl px-0.5 py-1.5 text-center',
              active(n.href) ? 'bg-rail-active text-white' : 'text-rail-text hover:bg-rail-active/60 hover:text-white')}>
            <Icon name={n.icon} size={21} className="nav-tint" style={tint(n.key)} />
            <span className="text-[10.5px] font-semibold leading-tight">{n.short}</span>
            {n.badge ? <span className="absolute right-1.5 top-1 min-w-[18px] rounded-full bg-[#E8590C] px-1 text-[10.5px] font-bold leading-[18px] text-white">{n.badge > 99 ? '99+' : n.badge}</span> : null}
          </Link>
        )) : tree.map((n) => {
          const on = nodeActive(n);
          return (
            <div key={n.id} className="flex flex-col">
              <Link href={n.href} aria-current={n.item && active(n.item.href) ? 'page' : undefined} data-nav-node={n.id}
                style={on ? { boxShadow: `inset 3px 0 0 ${moduleColor(n.id)}` } : undefined}
                className={clsx('flex min-h-[40px] items-center gap-2.5 rounded-xl px-2.5 text-[13.5px] font-semibold',
                  on ? 'bg-rail-active text-white' : 'text-rail-text hover:bg-rail-active/60 hover:text-white')}>
                <Icon name={n.icon} size={19} className="nav-tint" style={tint(n.id)} />
                <span className="min-w-0 flex-1 truncate">{n.label}</span>
                {n.children.length ? badgeEl(n.item?.badge ?? 0) : badgeEl(n.badge)}
              </Link>
              {n.children.length ? (
                <div className="mb-1 ml-[22px] flex flex-col border-l border-[#2A2E38] pl-2">
                  {n.children.map((c) => (
                    <Link key={c.key} href={c.href} aria-current={active(c.href) ? 'page' : undefined} data-nav-sub={c.key}
                      className={clsx('flex min-h-[28px] items-center gap-1.5 rounded-lg px-2 text-[12px]',
                        active(c.href) ? 'bg-rail-active font-bold text-white' : 'text-rail-text hover:bg-rail-active/60 hover:text-white')}>
                      <span className="min-w-0 flex-1 truncate">{SUB_LABEL[c.key] ?? c.label}</span>
                      {badgeEl(c.badge ?? 0, true)}
                    </Link>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
        <Link href="/me" title="Миний мэдээлэл" className={clsx('mt-auto flex items-center gap-2.5 rounded-xl', slim ? 'mx-auto' : 'px-1.5 py-1 hover:bg-rail-active/60')}>
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#2A2E38] text-[12px] font-bold text-[#ECEDEF]">{initials(user.name)}</span>
          {slim ? null : <span className="min-w-0 truncate text-[12.5px] font-semibold text-rail-text">{user.name}</span>}
        </Link>
      </nav>

      {/* Гар утас, таблет: дээд мөр */}
      <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-line bg-surface/95 px-3 pb-2 pt-[max(8px,env(safe-area-inset-top))] backdrop-blur lg:hidden">
        <button type="button" onClick={() => setOpen(true)} aria-label="Цэс нээх" aria-expanded={open}
          className="grid h-11 w-11 place-items-center rounded-xl bg-surface2 text-ink">
          <Icon name="menu" />
        </button>
        <div className="flex min-w-0 flex-1 flex-col leading-tight">
          <Logo small />
          <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] font-semibold text-muted">
            {current ? <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: moduleColor(current.key) }} /> : null}
            <span className="truncate">{current?.label ?? ''}</span>
          </span>
        </div>
        <AlertBell items={alerts} open={bellOpen} setOpen={setBellOpen} />
        <ThemeToggle />
      </header>
      {bellOpen ? <AlertPanel items={alerts} onClose={() => setBellOpen(false)} /> : null}

      {/* Гар утасны цэс */}
      {open ? (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Цэс">
          <button type="button" aria-label="Цэс хаах" className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 flex w-[min(320px,86vw)] flex-col overflow-y-auto bg-surface pb-[max(16px,env(safe-area-inset-bottom))] pt-[max(12px,env(safe-area-inset-top))] shadow-pop">
            <div className="flex items-center justify-between px-4 pb-3">
              <Logo />
              <button type="button" onClick={() => setOpen(false)} aria-label="Цэс хаах" className="grid h-11 w-11 place-items-center rounded-xl text-muted hover:bg-surface2">
                <Icon name="close" />
              </button>
            </div>
            <div className="flex flex-col px-2 pb-2">
              {tree.map((n) => (
                <div key={n.id} className="flex flex-col">
                  <Link href={n.href} aria-current={n.item && active(n.item.href) ? 'page' : undefined}
                    className={clsx('flex min-h-[46px] items-center gap-3 rounded-xl px-3 text-[15px] font-semibold',
                      nodeActive(n) ? 'bg-accent-soft text-accent-ink' : 'text-ink hover:bg-surface2')}>
                    <Icon name={n.icon} size={20} style={{ color: moduleColor(n.id) }} />
                    <span className="flex-1">{n.label}</span>
                    {(n.children.length ? n.item?.badge ?? 0 : n.badge) ? <span className="rounded-full bg-accent px-2 text-[12px] font-bold leading-6 text-on-accent">{n.children.length ? n.item?.badge : n.badge}</span> : null}
                    {n.item?.readOnly ? <span className="text-[11px] font-bold text-subtle">харах</span> : null}
                  </Link>
                  {n.children.length ? (
                    <div className="mb-1 ml-[26px] flex flex-col border-l border-line pl-2">
                      {n.children.map((c) => (
                        <Link key={c.key} href={c.href} aria-current={active(c.href) ? 'page' : undefined}
                          className={clsx('flex min-h-[38px] items-center gap-2 rounded-lg px-2.5 text-[13.5px]',
                            active(c.href) ? 'bg-accent-soft font-bold text-accent-ink' : 'text-muted hover:bg-surface2')}>
                          <span className="flex-1">{SUB_LABEL[c.key] ?? c.label}</span>
                          {c.badge ? <span className="rounded-full bg-accent px-1.5 text-[11px] font-bold leading-5 text-on-accent">{c.badge}</span> : null}
                          {c.readOnly ? <span className="text-[11px] font-bold text-subtle">харах</span> : null}
                        </Link>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
            <div className="mt-auto border-t border-line px-4 pt-3">
              <Link href="/me" className="flex items-center gap-3 rounded-xl py-2">
                <span className="grid h-10 w-10 place-items-center rounded-full bg-ink text-[13px] font-bold text-on-ink">{initials(user.name)}</span>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[14px] font-bold">{user.name}</span>
                  <span className="truncate text-[12px] text-muted">{user.roleLabels.join(', ')}</span>
                </span>
              </Link>
              <button type="button" onClick={logout} className="mt-2 flex h-11 w-full items-center gap-3 rounded-xl px-1 text-[15px] font-semibold text-bad-ink">
                <Icon name="logout" /> Гарах
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className={slim ? 'lg:pl-[84px]' : 'lg:pl-[204px]'}>
        <div className="mx-auto w-full max-w-[1400px] has-[.full-bleed]:max-w-none px-[max(16px,env(safe-area-inset-left))] pb-[max(24px,env(safe-area-inset-bottom))] pt-4 lg:px-7 lg:pt-6">
          {children}
        </div>
      </div>
    </div>
  );
}

interface AlertItem { key: string; level: 'bad' | 'warn'; icon: string; text: string; href?: string; link?: string }

/** Хонхны дүрс — анхааруулгын тоо; улаан нь яаралтай (бол анивчина) */
function AlertBell({ items, open, setOpen, dark }: { items: AlertItem[]; open: boolean; setOpen: (v: boolean) => void; dark?: boolean }) {
  const bad = items.some((a) => a.level === 'bad');
  return (
    <button type="button" data-alert-bell={items.length} onClick={() => setOpen(!open)} aria-expanded={open}
      aria-label={items.length ? `Анхааруулга ${items.length}` : 'Анхааруулга алга'} title={items.length ? `Анхааруулга ${items.length}` : 'Анхааруулга алга'}
      className={clsx('relative grid place-items-center rounded-xl', dark ? 'h-8 w-8 text-rail-text hover:bg-rail-active hover:text-white' : 'h-11 w-11 border border-line bg-surface text-ink')}>
      <svg aria-hidden="true" width={dark ? 18 : 20} height={dark ? 18 : 20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </svg>
      {items.length ? (
        <span className={clsx('absolute -right-1.5 -top-1.5 min-w-[18px] rounded-full px-1 text-center text-[10.5px] font-bold leading-[18px] text-white', bad ? 'animate-pulse bg-[#DC2626]' : 'bg-[#D97706]')}>{items.length}</span>
      ) : null}
    </button>
  );
}

function AlertPanel({ items, onClose }: { items: AlertItem[]; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Анхааруулга">
      <button type="button" aria-label="Хаах" className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div data-alert-panel className="absolute left-2 right-2 top-[max(64px,calc(env(safe-area-inset-top)+56px))] flex max-h-[80vh] flex-col overflow-hidden rounded-[16px] border border-line bg-surface shadow-pop lg:left-[96px] lg:right-auto lg:top-3 lg:w-[460px]">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <b className="text-[15px]">Анхааруулга {items.length ? `(${items.length})` : ''}</b>
          <button type="button" onClick={onClose} aria-label="Хаах" className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-surface2"><Icon name="close" size={18} /></button>
        </div>
        <div className="flex flex-col gap-2 overflow-y-auto p-3">
          {items.length ? items.map((a) => {
            const cls = clsx('flex gap-2.5 rounded-[12px] border px-3 py-2.5 text-[13.5px] font-semibold',
              a.level === 'bad' ? 'border-bad/40 bg-bad-soft text-bad-ink' : 'border-warn/40 bg-warn-soft text-warn');
            const body = (<><span aria-hidden className="shrink-0">{a.icon}</span><span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{a.text}{a.link ? <span className="mt-1 block text-[12.5px] underline">{a.link} →</span> : null}</span></>);
            return a.href
              ? <Link key={a.key} href={a.href} data-alert-item={a.key} onClick={onClose} className={clsx(cls, 'hover:brightness-95')}>{body}</Link>
              : <div key={a.key} data-alert-item={a.key} className={cls}>{body}</div>;
          }) : <p className="px-1 py-6 text-center text-[14px] text-muted">Анхааруулга алга ✓</p>}
        </div>
      </div>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, back }: { title: string; subtitle?: ReactNode; actions?: ReactNode; back?: { href: string; label?: string } }) {
  return (
    <div className="mb-5 flex flex-col gap-2">
      {back ? (
        <Link href={back.href} className="-ml-1 inline-flex h-9 w-fit items-center gap-1 rounded-[10px] px-1.5 text-[14px] font-semibold text-muted hover:bg-surface2 hover:text-ink">
          <Icon name="left" size={18} /> {back.label ?? 'Буцах'}
        </Link>
      ) : null}
      <PageBand title={title} subtitle={subtitle} actions={actions} />
    </div>
  );
}

/** «A» загварын хуудасны өнгөт толгой (өнгө нь --page — AppShell тохируулна) */
export function PageBand({ title, subtitle, actions, className, children }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; className?: string; children?: ReactNode }) {
  return (
    <div data-page-band className={clsx('page-band flex flex-wrap items-center justify-between gap-3 rounded-[16px] px-4 py-3.5 shadow-card md:px-5 md:py-4', className)}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <h1 className="min-w-0 break-words text-[22px] font-extrabold tracking-[-0.03em] md:text-[24px]">{title}</h1>
        {subtitle ? <div className="band-sub min-w-0 text-[13px] [overflow-wrap:anywhere]">{subtitle}</div> : null}
      </div>
      {actions ? <div className="flex min-w-0 flex-wrap items-center gap-2 text-ink">{actions}</div> : null}
      {children}
    </div>
  );
}
