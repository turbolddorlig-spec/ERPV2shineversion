'use client';
import clsx from 'clsx';
import { useId } from 'react';
import { Icon } from '@/components/icons';
import type { Img } from './ProductEditor';

/** Хадгалаагүй (сонгосон) зураг */
export interface PendingImage { id: string; file: File; color: string; url: string }
export type ImageOp = 'delete' | 'main' | 'up' | 'down' | 'color';

/** Нэг өнгөнд (эсвэл ерөнхийд) байх зургийн дээд тоо — сервертэй ижил (шийдвэр #32) */
export const MAX_PER_COLOR = 8;

/**
 * Зургийг өнгө тус бүрээр бүлэглэж, зураг бүрийг тусдаа нүдэнд харуулна.
 * Бүлэг бүрийн сүүлд «+» нүд — дарж тухайн өнгийн зургийг сонгоно.
 * Сонгосон зураг «Хадгалах» / «Бараа үүсгэх» дарахад хадгалагдана.
 */
export function ImageGroups({ colors, images, pending, canEdit, productName, onAdd, onRemovePending, onOp }: {
  colors: string[];
  images: Img[];
  pending: PendingImage[];
  canEdit: boolean;
  productName: string;
  onAdd: (color: string, files: File[]) => void;
  onRemovePending: (id: string) => void;
  onOp: (img: Img, op: ImageOp, color?: string) => void;
}) {
  // Барааны өнгөнөөс хасагдсан ч зурагтай үлдсэн өнгийг ч харуулна
  const orphan = [...new Set(images.map((i) => i.color).filter((c) => c && !colors.includes(c)))];
  const groups = ['', ...colors, ...orphan];

  return (
    <div className="flex flex-col gap-4">
      {groups.map((color) => {
        const imgs = images.filter((i) => i.color === color);
        const pend = pending.filter((p) => p.color === color);
        const used = imgs.length + pend.length;
        if (!canEdit && used === 0) return null;
        return (
          <div key={color || '_'} className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-[13.5px] font-bold">
                {color || 'Ерөнхий'}
                {!color ? <span className="font-medium text-subtle"> · бүх өнгө</span> : null}
                {orphan.includes(color) ? <span className="font-medium text-warn"> · өнгө хасагдсан</span> : null}
              </h3>
              <span className="text-[12px] text-subtle">{used}/{MAX_PER_COLOR}</span>
            </div>
            <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {imgs.map((img, i) => (
                <li key={img.id} className={clsx('flex flex-col gap-1 rounded-xl border p-1', img.isMain ? 'border-accent' : 'border-line')}>
                  <a href={img.lg} target="_blank" rel="noreferrer" className="relative block aspect-square overflow-hidden rounded-lg bg-surface2">
                    <img src={img.md} alt={`${productName} ${color || 'ерөнхий'} зураг ${i + 1}`} loading="lazy" className="h-full w-full object-cover" />
                    {img.isMain ? <span className="absolute left-1 top-1 rounded-md bg-accent px-1.5 text-[10.5px] font-bold text-on-accent">Үндсэн</span> : null}
                  </a>
                  {canEdit ? (
                    <div className="flex flex-wrap justify-center gap-0.5">
                      {!img.isMain ? <IconBtn label="Үндсэн зураг болгох" icon="star" onClick={() => onOp(img, 'main')} /> : null}
                      {i > 0 ? <IconBtn label="Урагш" icon="left" onClick={() => onOp(img, 'up')} /> : null}
                      {i < imgs.length - 1 ? <IconBtn label="Хойш" icon="right" onClick={() => onOp(img, 'down')} /> : null}
                      <IconBtn label="Зураг хасах" icon="trash" danger onClick={() => onOp(img, 'delete')} />
                    </div>
                  ) : null}
                  {canEdit && colors.length ? (
                    <select aria-label="Зургийн өнгө солих" value={img.color} onChange={(e) => onOp(img, 'color', e.target.value)}
                      className="h-8 w-full min-w-0 rounded-lg border border-line bg-surface px-1 text-[12px]">
                      <option value="">Ерөнхий</option>
                      {colors.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  ) : null}
                </li>
              ))}
              {pend.map((p) => (
                <li key={p.id} className="flex flex-col gap-1 rounded-xl border border-dashed border-accent p-1">
                  <span className="relative block aspect-square overflow-hidden rounded-lg bg-surface2">
                    <img src={p.url} alt={`Сонгосон зураг: ${p.file.name}`} className="h-full w-full object-cover" />
                    <span className="absolute inset-x-0 bottom-0 bg-ink/70 py-0.5 text-center text-[10.5px] font-bold text-on-ink">Хадгалаагүй</span>
                  </span>
                  <button type="button" onClick={() => onRemovePending(p.id)} className="h-8 rounded-lg bg-surface2 text-[12px] font-semibold">Болих</button>
                </li>
              ))}
              {canEdit && used < MAX_PER_COLOR ? <AddSlot color={color} left={MAX_PER_COLOR - used} onAdd={onAdd} /> : null}
            </ul>
          </div>
        );
      })}
      {canEdit ? <p className="text-[12px] text-subtle">JPG, PNG, WEBP · 10MB хүртэл. Өнгө бүрд {MAX_PER_COLOR} хүртэл зураг. Сонгосон зураг «Хадгалах» дарахад хадгалагдана.</p> : null}
    </div>
  );
}

function AddSlot({ color, left, onAdd }: { color: string; left: number; onAdd: (color: string, files: File[]) => void }) {
  const id = useId();
  return (
    <li>
      <label htmlFor={id} className="grid aspect-square cursor-pointer place-items-center rounded-xl border-2 border-dashed border-line text-muted hover:border-accent hover:text-accent-ink">
        <span className="flex flex-col items-center gap-1 text-center text-[12px] font-semibold">
          <Icon name="plus" size={22} />
          {color ? `${color} зураг` : 'Зураг нэмэх'}
        </span>
      </label>
      <input id={id} type="file" accept="image/jpeg,image/png,image/webp" multiple className="sr-only"
        aria-label={color ? `${color} өнгийн зураг нэмэх` : 'Ерөнхий зураг нэмэх'}
        onChange={(e) => { const f = Array.from(e.target.files ?? []).slice(0, left); e.target.value = ''; if (f.length) onAdd(color, f); }} />
    </li>
  );
}

function IconBtn({ label, icon, onClick, danger }: { label: string; icon: string; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick}
      className={clsx('grid h-8 w-8 place-items-center rounded-lg', danger ? 'bg-bad-soft text-bad-ink' : 'bg-surface2')}>
      <Icon name={icon} size={14} />
    </button>
  );
}
