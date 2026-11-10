'use client';
import { useState } from 'react';
import { Icon } from '../icons';

/** Өнгө, хэмжээ оруулах: бичээд Enter (эсвэл таслал) → чип */
export function ChipsInput({ id, label, values, onChange, placeholder, disabled }: {
  id: string; label: string; values: string[]; onChange: (v: string[]) => void; placeholder?: string; disabled?: boolean;
}) {
  const [text, setText] = useState('');
  const add = (raw: string) => {
    const parts = raw.split(',').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
    const next = [...values];
    for (const p of parts) if (!next.some((v) => v.toLowerCase() === p.toLowerCase())) next.push(p.slice(0, 30));
    onChange(next.slice(0, 30));
    setText('');
  };
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-semibold text-muted">{label}</label>
      <div className="flex min-h-[48px] flex-wrap items-center gap-1.5 rounded-xl border border-line bg-surface px-2 py-1.5 focus-within:border-accent">
        {values.map((v) => (
          <span key={v} className="inline-flex h-8 items-center gap-1 rounded-lg bg-surface2 pl-2.5 pr-1 text-[13.5px] font-semibold">
            {v}
            {!disabled ? (
              <button type="button" aria-label={`${v} хасах`} onClick={() => onChange(values.filter((x) => x !== v))}
                className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-line"><Icon name="close" size={14} /></button>
            ) : null}
          </span>
        ))}
        {!disabled ? (
          <input id={id} value={text} placeholder={values.length ? '' : placeholder}
            onChange={(e) => { const v = e.target.value; if (v.includes(',')) add(v); else setText(v); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); if (text.trim()) add(text); }
              if (e.key === 'Backspace' && !text && values.length) onChange(values.slice(0, -1));
            }}
            onBlur={() => { if (text.trim()) add(text); }}
            className="h-9 min-w-[120px] flex-1 bg-transparent px-1 text-ink outline-none placeholder:text-subtle" />
        ) : null}
      </div>
      {!disabled ? <p className="text-[12px] text-subtle">Бичээд Enter дарна. Жишээ: Хар, Цагаан</p> : null}
    </div>
  );
}
