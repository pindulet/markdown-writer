import { useEffect, useRef } from "react";

export interface MenuItem {
  label: string;
  action: () => void;
  danger?: boolean;
}

export default function ContextMenu({
  x = 0,
  y = 0,
  items,
  onClose,
  sheet = false,
  title,
}: {
  x?: number;
  y?: number;
  items: MenuItem[];
  onClose: () => void;
  sheet?: boolean; // mobil: bundark med store knapper i stedet for en menu ved musen
  title?: string; // kun bundark
}) {
  const openedAt = useRef(Date.now());

  useEffect(() => {
    if (sheet) {
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") onClose();
      };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }
    const close = () => onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
    };
  }, [onClose, sheet]);

  if (sheet) {
    return (
      <div
        className="sheet-overlay"
        onClick={() => {
          // det klik, der afslutter et langt tryk, må ikke lukke arket igen
          if (Date.now() - openedAt.current > 350) onClose();
        }}
      >
        <div className="sheet" role="menu" onClick={(e) => e.stopPropagation()}>
          <div className="sheet-group">
            {title && <div className="sheet-title">{title}</div>}
            {items.map((item) => (
              <button
                key={item.label}
                className={"sheet-item" + (item.danger ? " danger" : "")}
                role="menuitem"
                onClick={() => {
                  onClose();
                  item.action();
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
          <button className="sheet-item sheet-cancel" onClick={onClose}>
            Annuller
          </button>
        </div>
      </div>
    );
  }

  const top = Math.min(y, window.innerHeight - items.length * 30 - 16);
  const left = Math.min(x, window.innerWidth - 180);

  return (
    <div
      className="context-menu"
      style={{ left, top }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((item) => (
        <div
          key={item.label}
          className={"context-item" + (item.danger ? " danger" : "")}
          onClick={() => {
            item.action();
            onClose();
          }}
        >
          {item.label}
        </div>
      ))}
    </div>
  );
}
