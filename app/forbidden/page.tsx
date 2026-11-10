import Link from 'next/link';

export const metadata = { title: 'Эрхгүй · zahialga•' };

export default function Forbidden() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="max-w-[420px] text-center">
        <p className="text-[13px] font-bold uppercase tracking-[0.07em] text-subtle">403</p>
        <h1 className="mt-2 text-[24px] font-extrabold">Танд энэ хуудсыг үзэх эрх байхгүй</h1>
        <p className="mt-2 text-[14px] text-muted">Эрх хэрэгтэй бол ахлагч эсвэл админдаа хандана уу.</p>
        <Link href="/" className="mt-5 inline-flex h-11 items-center rounded-xl bg-ink px-5 font-bold text-on-ink">Нүүр хуудас руу</Link>
      </div>
    </main>
  );
}
