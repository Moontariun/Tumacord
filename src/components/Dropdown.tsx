import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';

export interface DropdownOption {
  value: string;
  label: string;
  hint?: string;
}

// O <select> nativo abre um popup desenhado pelo sistema: no Linux/Wayland ele
// ignora o tema escuro do aplicativo e as opções saem em branco. Esta lista é
// desenhada pelo próprio Tumacord e vai para um portal com posição fixa, então
// nunca é cortada pelo rodapé da call nem pelas barras com rolagem.
export function Dropdown({ value, options, onChange, label, className, disabled }: {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  label: string;
  className?: string;
  disabled?: boolean;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [box, setBox] = useState<{ left: number; top: number; width: number; dropUp: boolean } | null>(null);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const selected = options[selectedIndex];

  const place = useCallback(() => {
    const anchor = trigger.current?.getBoundingClientRect();
    if (!anchor) return;
    const height = Math.min(300, options.length * 40 + 12);
    const below = window.innerHeight - anchor.bottom;
    const dropUp = below < height + 16 && anchor.top > below;
    setBox({
      left: Math.max(8, Math.min(anchor.left, window.innerWidth - anchor.width - 8)),
      top: dropUp ? anchor.top - 6 : anchor.bottom + 6,
      width: anchor.width,
      dropUp,
    });
  }, [options.length]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    setActive(selectedIndex);
  }, [open, place, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (trigger.current?.contains(target) || panel.current?.contains(target)) return;
      setOpen(false);
    };
    const onViewportChange = () => place();
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [open, place]);

  const commit = (index: number) => {
    const option = options[index];
    setOpen(false);
    trigger.current?.focus();
    if (option && option.value !== value) onChange(option.value);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (disabled) return;
    if (event.key === 'Escape') {
      if (!open) return;
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (!open && (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      setOpen(true);
      return;
    }
    if (!open) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((current) => Math.min(options.length - 1, current + 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((current) => Math.max(0, current - 1)); }
    else if (event.key === 'Home') { event.preventDefault(); setActive(0); }
    else if (event.key === 'End') { event.preventDefault(); setActive(options.length - 1); }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); commit(active); }
  };

  return <div className={`dropdown ${className ?? ''}`}>
    <button
      ref={trigger}
      type="button"
      className={`dropdown-trigger ${open ? 'is-open' : ''}`}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-label={label}
      disabled={disabled}
      onClick={() => setOpen((current) => !current)}
      onKeyDown={onKeyDown}
    >
      <span>{selected?.label ?? ''}</span>
      <Icon name="chevron" />
    </button>
    {open && box && createPortal(
      <div
        ref={panel}
        className={`dropdown-panel ${box.dropUp ? 'drops-up' : ''}`}
        role="listbox"
        aria-label={label}
        style={{ left: box.left, top: box.top, minWidth: box.width, transform: box.dropUp ? 'translateY(-100%)' : undefined }}
        onKeyDown={onKeyDown}
      >
        {options.map((option, index) => <button
          key={option.value}
          type="button"
          role="option"
          aria-selected={option.value === value}
          className={`dropdown-option ${index === active ? 'is-active' : ''} ${option.value === value ? 'is-selected' : ''}`}
          onPointerEnter={() => setActive(index)}
          onClick={() => commit(index)}
        >
          <span>{option.label}{option.hint && <small>{option.hint}</small>}</span>
          {option.value === value && <i />}
        </button>)}
      </div>,
      document.body,
    )}
  </div>;
}
