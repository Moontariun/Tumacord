import { useLayoutEffect, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './Icon';

// O menu do botão direito.
//
// Ele vai para um portal com posição fixa pelo mesmo motivo do `Dropdown`: o
// quadro de uma live tem `overflow: hidden` e `contain`, e um menu desenhado
// dentro dele sairia cortado justamente perto da borda, onde as pessoas clicam.

export type ContextMenuEntry =
  | { label: string; icon?: IconName; onSelect: () => void; danger?: boolean; disabled?: boolean; hint?: string }
  | { separator: true };

export interface ContextMenuState {
  x: number;
  y: number;
  title?: string;
  items: ContextMenuEntry[];
}

export function ContextMenu({ menu, onClose }: { menu: ContextMenuState; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: menu.x, top: menu.y });
  const close = useRef(onClose);
  close.current = onClose;

  // Aberto perto da borda, o menu abre para o outro lado em vez de sair da tela.
  useLayoutEffect(() => {
    const box = panel.current?.getBoundingClientRect();
    if (!box) return;
    setPosition({
      left: Math.max(8, Math.min(menu.x, window.innerWidth - box.width - 8)),
      top: Math.max(8, menu.y + box.height > window.innerHeight - 8 ? menu.y - box.height : menu.y),
    });
    panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [menu.x, menu.y]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node)) close.current(); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close.current(); };
    const onLeave = () => close.current();
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onLeave);
    window.addEventListener('blur', onLeave);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onLeave);
      window.removeEventListener('blur', onLeave);
    };
  }, []);

  return createPortal(<div ref={panel} className="context-menu" role="menu" style={{ left: position.left, top: position.top }} onContextMenu={(event) => event.preventDefault()}>
    {menu.title && <div className="context-menu-title">{menu.title}</div>}
    {menu.items.map((item, index) => 'separator' in item
      ? <hr key={`sep-${index}`} />
      : <button
          key={`${item.label}-${index}`}
          type="button"
          role="menuitem"
          className={item.danger ? 'danger' : ''}
          disabled={item.disabled}
          title={item.hint}
          onClick={() => { close.current(); item.onSelect(); }}
        >{item.icon ? <Icon name={item.icon} /> : <span className="context-menu-gap" />}<span>{item.label}</span></button>)}
  </div>, document.body);
}
