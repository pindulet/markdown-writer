import { useMemo, useState } from "react";
import { useStore } from "../store";
import { isMobileNow } from "../useIsMobile";
import { keepKeyboard, releaseKeyboard } from "../keyboardKeeper";

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
    if (trimmed) {
      const mobile = isMobileNow();
      // iOS: skal ske synkront i trykket, før dialogens felt forsvinder
      if (mobile) keepKeyboard();
      const created = useStore.getState().newNote(trimmed, dir);
      if (mobile) {
        // mobil: en ny note åbnes direkte i redigeringstilstand
        created.then(
          () => {
            const s = useStore.getState();
            s.setEditing(true);
            s.setSidebarVisible(false);
          },
          (e: unknown) => {
            releaseKeyboard();
            console.error("Noten kunne ikke oprettes", e);
          }
        );
      } else {
        void created;
      }
    }
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
