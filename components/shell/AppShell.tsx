'use client';
import clsx from 'clsx';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { Icon } from '../icons';
import { ThemeToggle } from './ThemeToggle';
import { buildTree, SUB_LABEL } from './navTree';

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

export function AppShell({ user, nav, alert, boostAlert, reorderAlert, reorderHref, assignAlert, handoverAlert, jobsAlert, shortageSkip, backupAlert, children }: { user: { name: string; roleLabels: string[] }; nav: NavItem[]; alert?: StockAlert | null; boostAlert?: { red: number; orange: number } | null; reorderAlert?: { urgent: number; order: number; late: number } | null; reorderHref?: string; assignAlert?: { today: number; leftover: number; late: boolean; hour: number } | null; handoverAlert?: { count: number } | null; jobsAlert?: { at: string } | null; shortageSkip?: { date: string; at: string } | null; backupAlert?: { level: 'bad' | 'warn'; text: string }[] | null; children: ReactNode }) {
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

  return (
    <div className="min-h-screen">
      {/* Компьютер, том таблет: зүүн цэс — өргөн (бүтэцтэй, #130) эсвэл нарийн (хуучин rail) */}
      <nav aria-label="Үндсэн цэс" data-nav={slim ? 'slim' : 'wide'} className={clsx('fixed inset-y-0 left-0 z-30 hidden flex-col gap-0.5 overflow-y-auto bg-rail py-3.5 lg:flex', slim ? 'w-[84px] px-2' : 'w-[204px] px-2.5')}>
        <div className={clsx('mb-3 flex items-center', slim ? 'flex-col gap-2' : 'justify-between pl-1')}>
          <Link href="/" aria-label="Нүүр" className="grid h-11 w-11 place-items-center rounded-[13px] bg-[#E8590C] text-[22px] font-extrabold tracking-[-0.04em] text-white">
            z<span className="text-[#16181D]">.</span>
          </Link>
          <button type="button" onClick={toggleSlim} aria-label={slim ? 'Цэсийг өргөн болгох' : 'Цэсийг нарийн болгох'} title={slim ? 'Өргөн цэс' : 'Нарийн цэс'}
            className="grid h-8 w-8 place-items-center rounded-lg text-[15px] font-bold text-rail-text hover:bg-rail-active hover:text-white">{slim ? '»' : '«'}</button>
        </div>
        {slim ? nav.map((n) => (
          <Link key={n.key} href={n.href} aria-current={active(n.href) ? 'page' : undefined} title={n.label}
            className={clsx('relative flex min-h-[58px] flex-col items-center justify-center gap-1 rounded-xl px-0.5 py-1.5 text-center',
              active(n.href) ? 'bg-rail-active text-white' : 'text-rail-text hover:bg-rail-active/60 hover:text-white')}>
            <Icon name={n.icon} size={21} className={active(n.href) ? 'text-[#FF8A4C]' : undefined} />
            <span className="text-[10.5px] font-semibold leading-tight">{n.short}</span>
            {n.badge ? <span className="absolute right-1.5 top-1 min-w-[18px] rounded-full bg-[#E8590C] px-1 text-[10.5px] font-bold leading-[18px] text-white">{n.badge > 99 ? '99+' : n.badge}</span> : null}
          </Link>
        )) : tree.map((n) => {
          const on = nodeActive(n);
          return (
            <div key={n.id} className="flex flex-col">
              <Link href={n.href} aria-current={n.item && active(n.item.href) ? 'page' : undefined} data-nav-node={n.id}
                className={clsx('flex min-h-[40px] items-center gap-2.5 rounded-xl px-2.5 text-[13.5px] font-semibold',
                  on ? 'bg-rail-active text-white' : 'text-rail-text hover:bg-rail-active/60 hover:text-white')}>
                <Icon name={n.icon} size={19} className={on ? 'text-[#FF8A4C]' : undefined} />
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
          <span className="truncate text-[12.5px] font-semibold text-muted">{current?.label ?? ''}</span>
        </div>
        <ThemeToggle />
      </header>

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
                    <Icon name={n.icon} size={20} />
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
          {jobsAlert ? (
            <div role="alert" data-jobs-alert className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[14px] border border-bad/40 bg-bad-soft px-4 py-3 text-[13.5px] font-semibold text-bad-ink">
              <span aria-hidden>⛔</span>
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">Автомат ажил (захиалга цуцлах, Meta, шөнийн өр, Gmail, тулгалт) {ubTime(jobsAlert.at)}-аас хойш ажиллаагүй байна — серверийг шалгуулна уу.</span>
            </div>
          ) : null}
          {backupAlert?.length ? (
            <div role="alert" data-backup-alert className={clsx('mb-4 flex flex-col gap-1 rounded-[14px] border px-4 py-3 text-[13.5px] font-semibold',
              backupAlert.some((a) => a.level === 'bad') ? 'border-bad/40 bg-bad-soft text-bad-ink' : 'border-warn/40 bg-warn-soft text-warn')}>
              {backupAlert.map((a, i) => (
                <span key={i} className="flex min-w-0 gap-2"><span aria-hidden>{a.level === 'bad' ? '⛔' : '⚠️'}</span><span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{a.text}</span></span>
              ))}
            </div>
          ) : null}
          {shortageSkip ? (
            <Link href="/accounting" role="alert" data-shortage-skip className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[14px] border border-warn/40 bg-warn-soft px-4 py-3 text-[13.5px] font-semibold text-warn hover:brightness-95">
              <span aria-hidden>⚠️</span>
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{shortageSkip.date}-ны жолоочийн дутуу барааны автомат өр хоцорсон ({ubTime(shortageSkip.at)}) тул бичигдсэнгүй — Тооцоо → Өр хэсэгт жолооч бүрээр шалгаж, шаардлагатай бол «Одоо хаах»-аар бодно уу.</span>
            </Link>
          ) : null}
          {alert ? (
            <Link href="/warehouse" role="alert" className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[14px] border border-bad/40 bg-bad-soft px-4 py-3 text-[13.5px] font-semibold text-bad-ink hover:brightness-95">
              <span className="text-[16px]">⚠</span>
              {alert.kind === 'mismatch'
                ? <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">Үлдэгдлийн тулгалтад {alert.count} зөрүү илэрлээ (журнал ≠ үлдэгдэл){alert.since ? ` · ${ubTime(alert.since)}-аас` : ''}. Агуулах руу орж шалгана уу.</span>
                : <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">Цаг тутмын автомат тулгалт {ubTime(alert.at)}-аас хойш ажиллаагүй байна. Агуулах → «Дахин шалгах».</span>}
              <span className="text-[12.5px] underline">Агуулах →</span>
            </Link>
          ) : null}
          {boostAlert ? (
            <Link href={boostAlert.red ? '/goods-outflow?tab=red' : '/goods-outflow?tab=orange'} role="alert" data-boost-alert
              className={clsx('mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[14px] border px-4 py-3 text-[13.5px] font-semibold hover:brightness-95',
                boostAlert.red ? 'animate-pulse border-bad/40 bg-bad-soft text-bad-ink' : 'border-warn/40 bg-warn-soft text-warn')}>
              <span className="text-[16px]">{boostAlert.red ? '🔴' : '🟠'}</span>
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                {boostAlert.red ? `Алдагдалтай бүүст: ${boostAlert.red} бараа — яаралтай шалгаж унтраана уу.` : ''}
                {boostAlert.orange ? ` Ашиг багассан / өсөлтгүй бүүст: ${boostAlert.orange} бараа.` : ''}
              </span>
              <span className="text-[12.5px] underline">Барааны гарц →</span>
            </Link>
          ) : null}
          {assignAlert ? (
            <Link href="/driver-lead" role="alert" data-assign-alert
              className="mb-4 flex animate-pulse flex-wrap items-center gap-x-3 gap-y-1 rounded-[14px] border border-bad/40 bg-bad-soft px-4 py-3 text-[13.5px] font-semibold text-bad-ink hover:brightness-95">
              <span className="text-[16px]">🔴</span>
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                {assignAlert.leftover ? `Хоносон, хуваарилагдаагүй ${assignAlert.leftover} захиалга байна — яаралтай хуваарилна уу.` : ''}
                {assignAlert.late && assignAlert.today ? ` ${String(assignAlert.hour).padStart(2, '0')}:00 болсон — өнөөдрийн ${assignAlert.today} «Шинэ» захиалга хуваарилагдаагүй байна.` : ''}
              </span>
              <span className="text-[12.5px] underline">Хуваарилалт →</span>
            </Link>
          ) : null}
          {handoverAlert ? (
            <Link href="/handover" role="alert" data-handover-alert
              className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[14px] border border-bad/40 bg-bad-soft px-4 py-3 text-[13.5px] font-semibold text-bad-ink hover:brightness-95">
              <span className="text-[16px]">🔴</span>
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">Агуулах өгсөн боловч жолооч 2 цагаас удаан хүлээн аваагүй {handoverAlert.count} падаан байна — бараа жолоочийн гарт, захиалга хүргэлтэд гараагүй.</span>
              <span className="text-[12.5px] underline">Падаан →</span>
            </Link>
          ) : null}
          {reorderAlert ? (
            <Link href={reorderHref ?? '/goods-outflow?tab=reorder'} role="alert" data-reorder-alert
              className={clsx('mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[14px] border px-4 py-3 text-[13.5px] font-semibold hover:brightness-95',
                reorderAlert.urgent || reorderAlert.late ? 'border-bad/40 bg-bad-soft text-bad-ink' : 'border-warn/40 bg-warn-soft text-warn')}>
              <span className="text-[16px]">🚚</span>
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                Бараа их гарч байна, дуусах дөхлөө — бараагаа татаарай:
                {reorderAlert.urgent ? ` 🔴 яаралтай ${reorderAlert.urgent}` : ''}
                {reorderAlert.order ? ` 🟠 татах ${reorderAlert.order}` : ''}
                {reorderAlert.late ? ` ⏰ ирэх хугацаа хэтэрсэн ${reorderAlert.late}` : ''} бараа.
              </span>
              <span className="text-[12.5px] underline">{reorderHref === '/supplier' ? 'Миний барааны гарц →' : 'Барааны гарц →'}</span>
            </Link>
          ) : null}
          {children}
        </div>
      </div>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, back }: { title: string; subtitle?: ReactNode; actions?: ReactNode; back?: { href: string; label?: string } }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        {back ? (
          <Link href={back.href} className="-ml-1 mb-1 inline-flex h-9 w-fit items-center gap-1 rounded-[10px] px-1.5 text-[14px] font-semibold text-muted hover:bg-surface2 hover:text-ink">
            <Icon name="left" size={18} /> {back.label ?? 'Буцах'}
          </Link>
        ) : null}
        <h1 className="text-[24px] font-extrabold tracking-[-0.03em] md:text-[26px]">{title}</h1>
        {subtitle ? <p className="text-[13.5px] text-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
