const SHORTCUTS: Array<[string, string]> = [
  ["⌘N", "Ny note"],
  ["⌘E", "Skift mellem markdown- og layout-visning"],
  ["⌘\\", "Vis/skjul venstre kolonne (fokustilstand)"],
  ["⌘B", "Fed"],
  ["⌘I", "Kursiv"],
  ["⌘K", "Indsæt link"],
  ["⌘1 – ⌘6", "Overskrift 1–6"],
  ["⌘0", "Brødtekst (fjern overskrift)"],
  ["Tab / ⇧Tab", "Ryk ind / ryk ud (lister)"],
  ["⌘Z / ⇧⌘Z", "Fortryd / annullér fortryd"],
  ["⌘/", "Vis denne oversigt"],
  ["⌘-klik på link", "Åbn link i browseren"],
  ["Højreklik på markering", "Formateringsmenu"],
  ["Højreklik på et ord", "Staveforslag (macOS)"],
];

export default function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="dialog-overlay" onMouseDown={onClose}>
      <div
        className="dialog shortcuts-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-title">Tastaturgenveje</div>
        <div className="shortcuts-list">
          {SHORTCUTS.map(([keys, label]) => (
            <div className="shortcut-row" key={keys}>
              <span className="shortcut-keys">{keys}</span>
              <span className="shortcut-label">{label}</span>
            </div>
          ))}
        </div>
        <div className="dialog-actions">
          <button className="secondary-btn" onClick={onClose}>
            Luk
          </button>
        </div>
      </div>
    </div>
  );
}
