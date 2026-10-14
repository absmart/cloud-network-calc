import { useEffect, useRef, useState } from 'react';

export interface MenuItem {
  label: string;
  title?: string;
  onSelect: () => void;
  /** Draw a separator above this item. */
  separated?: boolean;
}

/** A button that opens a list of actions. Closes on choosing, Escape or clicking elsewhere. */
export function Menu(props: { label: string; title: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', onDown);
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const items = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      items[(at + step + items.length) % items.length]?.focus();
    }
  };

  return (
    <div className="menu" ref={root} onKeyDown={onKeyDown}>
      <button
        ref={button}
        title={props.title}
        aria-label={props.title}
        aria-haspopup="menu"
        aria-expanded={open}
        className={open ? 'active' : ''}
        onClick={() => setOpen(!open)}
      >
        {props.label}
      </button>
      {open && (
        <div className="menu-list" role="menu">
          {props.items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              title={item.title}
              className={item.separated ? 'separated' : ''}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
