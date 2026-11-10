'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../icons';

/** Томруулж харах зураг */
export interface ZoomImg { src: string; alt: string; name?: string }

const TR: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', ө: 'u',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ү: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sh', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};
/** Татаж авах файлын нэр: кирилл үсгийг латинаар (зарим хөтөч, утас кирилл нэрийг «download» болгодог) */
export function safeFileName(s: string): string {
  const out = [...s].map((ch) => { const l = ch.toLowerCase(); const t = TR[l]; return t === undefined ? ch : ch === l ? t : t.charAt(0).toUpperCase() + t.slice(1); }).join('');
  return out.replace(/\.[a-z0-9]{2,5}$/i, (m) => m).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'zurag';
}

/** Жижиг зургийн URL (…-sm.webp / …-md.webp) → том зураг (…-lg.webp) */
export const largeOf = (url: string) => url.replace(/-(sm|md)\.webp$/, '-lg.webp');

/**
 * Зураг дээр дарахад бүтэн дэлгэцээр томруулж харуулна, «Татаж авах» товчтой (шийдвэр #36).
 * Оператор үйлчлүүлэгчид чатаар илгээх, жолооч / агуулах бараагаа ялгах зэрэгт ашиглана.
 * Олон зурагтай бол сум, гар утсанд шудрах, гарын ← → товчоор шилжинэ.
 */
export function ZoomButton({ images, index = 0, label, className, children }: {
  images: ZoomImg[]; index?: number; label: string; className?: string; children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (!images.length) return <>{children}</>;
  return (
    <>
      <button type="button" aria-label={label} title="Томруулж харах" className={className ?? 'block shrink-0 cursor-zoom-in rounded-[10px]'}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(true); }}>
        {children}
      </button>
      {open ? <Lightbox images={images} start={index} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export function Lightbox({ images, start, onClose }: { images: ZoomImg[]; start: number; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [i, setI] = useState(Math.min(Math.max(start, 0), images.length - 1));
  const touchX = useRef<number | null>(null);
  const many = images.length > 1;
  const go = (d: number) => setI((x) => (x + d + images.length) % images.length);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => { if (d?.open) d.close(); };
  }, []);
  useEffect(() => {
    if (!many) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'ArrowLeft') go(-1); if (e.key === 'ArrowRight') go(1); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [many]);

  const img = images[i]!;
  const base = safeFileName(img.name ?? img.alt);
  // Хадгалаагүй (сонгосон) зураг өөрийн өргөтгөлтэй; серверийн зураг WEBP
  const fileName = img.src.startsWith('blob:') ? base : `${base}.webp`;
  return (
    <dialog ref={ref} onClose={onClose} onCancel={(e) => { e.preventDefault(); onClose(); }} aria-label={img.alt}
      className="m-0 h-[100dvh] max-h-none w-screen max-w-none bg-black p-0 text-white backdrop:bg-black/80">
      <div className="flex h-full flex-col"
        onTouchStart={(e) => { touchX.current = e.touches[0]?.clientX ?? null; }}
        onTouchEnd={(e) => {
          const x0 = touchX.current; touchX.current = null;
          const x1 = e.changedTouches[0]?.clientX;
          if (many && x0 != null && x1 != null && Math.abs(x1 - x0) > 50) go(x1 < x0 ? 1 : -1);
        }}>
        <div className="flex items-center gap-2 px-3 pb-2 pt-[max(12px,env(safe-area-inset-top))]">
          <p className="min-w-0 flex-1 truncate text-[14px] font-semibold">{img.alt}{many ? <span className="text-white/60"> · {i + 1}/{images.length}</span> : null}</p>
          <a href={img.src} download={fileName}
            className="inline-flex h-11 items-center gap-2 rounded-[11px] bg-white px-4 text-[14px] font-bold text-black">
            <Icon name="download" size={17} /> Татаж авах
          </a>
          <button type="button" onClick={onClose} aria-label="Хаах" className="grid h-11 w-11 place-items-center rounded-[11px] bg-white/15">
            <Icon name="close" />
          </button>
        </div>
        <div className="relative flex min-h-0 flex-1 items-center justify-center px-2 pb-[max(12px,env(safe-area-inset-bottom))]" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
          <img src={img.src} alt={img.alt} className="max-h-full max-w-full select-none rounded-lg object-contain" />
          {many ? (
            <>
              <button type="button" onClick={() => go(-1)} aria-label="Өмнөх зураг" className="absolute left-2 top-1/2 grid h-12 w-12 -translate-y-1/2 place-items-center rounded-full bg-white/15 hover:bg-white/25"><Icon name="left" /></button>
              <button type="button" onClick={() => go(1)} aria-label="Дараагийн зураг" className="absolute right-2 top-1/2 grid h-12 w-12 -translate-y-1/2 place-items-center rounded-full bg-white/15 hover:bg-white/25"><Icon name="right" /></button>
            </>
          ) : null}
        </div>
      </div>
    </dialog>
  );
}
