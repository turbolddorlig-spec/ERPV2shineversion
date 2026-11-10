'use client';
export function PrintButton() {
  return <button type="button" onClick={() => window.print()} className="rounded-lg bg-black px-4 py-2 text-[13px] font-bold text-white">Хэвлэх</button>;
}
