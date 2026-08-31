import { useMemo, useState } from "react";
import { useStore } from "../store";

export default function NewNoteDialog({ onClose }: { onClose: () => void }) {
  const files = useStore((s) => s.files);
  const folder = useStore((s) => s.folder);
  const initialDir = useStore((s) => s.newNoteDir);
  const [name, setName] = useState("");
  const [dir, setDir] = useState(initialDir);

  // alle undermapper, der indeholder noter — inkl. mellemliggende niveauer
  const dirs = useMemo(() => {
    const set = new Set<string>();
    for (const f of files) {
      if (!f.rel_dir) continue;
      const parts = f.rel_dir.split("/");
      let acc = "";
      for (const part of parts) {
        acc = acc ? `${acc}/${part}` : part;
        set.add(acc);
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, "da"));
  }, [files]);

  const rootName = folder?.split("/").filter(Boolean).pop() ?? "Noter";

  const submit = () => {
    const trimmed = name.trim();
    if (trimmed) void useStore.getState().newNote(trimmed, dir);
    onClose();
  };

  return (
    <div className="dialog-overlay" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-title">Ny note</div>
        <input
          className="dialog-input"
          autoFocus
          value={name}
          placeholder="Titel på noten"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") onClose();
          }}
        />
        <select
          className="dialog-select"
          value={dir}
          onChange={(e) => setDir(e.target.value)}
        >
          <option value="">{rootName}</option>
          {dirs.map((d) => (
            <option key={d} value={d}>
              {d.replaceAll("/", " / ")}
            </option>
          ))}
        </select>
        <div className="dialog-actions">
          <button className="secondary-btn" onClick={onClose}>
            Annuller
          </button>
          <button className="primary-btn" onClick={submit}>
            Opret
          </button>
        </div>
      </div>
    </div>
  );
}
