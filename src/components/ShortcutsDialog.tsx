const SHORTCUTS: Array<[string, string]> = [
  ["⌘N", "Ny note"],
  ["⌘E", "Skift mellem markdown- og layout-visning"],
  ["⌘\\", "Vis/skjul venstre kolonne (fokustilstand)"],
  ["⌘B", "Fed"],
  ["⌘I", "Kursiv"],
  ["⌘K", "Indsæt link"],
  ["⌘1 – ⌘6", "Overskrift 1–6"],
  ["⇧⌘9", "Tjekliste"],
  ["⌘0", "Brødtekst (fjern overskrift)"],
  ["Tab / ⇧Tab", "Ryk ind / ryk ud (lister)"],
  ["⌘Z / ⇧⌘Z", "Fortryd / annullér fortryd"],
  ["⌘+ / ⌘−", "Zoom tekst ind/ud"],
  ["⇧⌘0", "Nulstil zoom"],
  ["⌥Tab", "AI: foreslå fortsættelse (markdown-visning)"],
  ["Tab", "AI: acceptér gråt forslag"],
  ["Esc", "AI: afvis forslag"],
  ["⇧⌘J", "AI-forslag til/fra"],
  ["⌘/", "Vis denne oversigt"],
  ["⌘-klik på link", "Åbn link i browseren"],
  ["Højreklik på markering", "Formateringsmenu"],
  ["Højreklik på et ord", "Staveforslag (macOS)"],
];

// fx "2. okt. 2026 kl. 16.10"
function buildDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const date = d.toLocaleDateString("da-DK", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const time = d.toLocaleTimeString("da-DK", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${date} kl. ${time}`;
}

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
          <span
            style={{
              marginRight: "auto",
              alignSelf: "center",
              fontSize: 11.5,
              color: "var(--text-faint)",
              userSelect: "text",
            }}
          >
            Version {__APP_VERSION__} · bygget {buildDate(__BUILD_TIME__)}
          </span>
          <button className="secondary-btn" onClick={onClose}>
            Luk
          </button>
        </div>
      </div>
    </div>
  );
}
