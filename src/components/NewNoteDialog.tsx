import { useMemo, useState } from "react";
import { useStore } from "../store";

export default function NewNoteDialog({ onClose }: { onClose: () => void }) {
  const allDirs = useStore((s) => s.dirs);
  const folder = useStore((s) => s.folder);
  const initialDir = useStore((s) => s.newNoteDir);
  const [name, setName] = useState("");
  const [dir, setDir] = useState(initialDir);

  const dirs = useMemo(
    () => [...allDirs].sort((a, b) => a.localeCompare(b, "da")),
    [allDirs]
  );

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
