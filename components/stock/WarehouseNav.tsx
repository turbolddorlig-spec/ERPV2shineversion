'use client';
import clsx from 'clsx';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/warehouse', label: 'Үлдэгдэл', exact: true },
  { href: '/warehouse/refill', label: 'Дүүргэлт' },
  { href: '/warehouse/transfers', label: 'Шилжүүлэг' },
  { href: '/warehouse/counts', label: 'Тооллого' },
  { href: '/warehouse/moves', label: 'Хөдөлгөөн' },
  { href: '/warehouse/issues', label: 'Зарлага хянах' },
  { href: '/loans', label: 'Бараа зээл' },
  { href: '/warehouse/settings', label: 'Агуулахууд' },
];

/** Агуулахын дэд цэс — бүх ажил хоорондоо нэг товчоор */
export function WarehouseNav() {
  const path = usePathname();
  return (
    <nav aria-label="Агуулахын цэс" className="-mx-4 mb-4 overflow-x-auto px-4 md:mx-0 md:px-0">
      <ul className="flex w-max gap-1.5">
        {TABS.map((t) => {
          const active = t.exact ? path === t.href : path.startsWith(t.href);
          return (
            <li key={t.href}>
              <Link href={t.href} aria-current={active ? 'page' : undefined}
                className={clsx('inline-flex h-10 items-center rounded-full border px-4 text-[13.5px] font-semibold', active ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface text-ink hover:bg-surface2')}>
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
