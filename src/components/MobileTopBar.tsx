import { useEffect, useState } from "react";
import { platform } from "../backend";
import { useStore, type Doc } from "../store";
import { saveStatusLabel } from "./StatusBar";
import ContextMenu from "./ContextMenu";
import ConfirmDialog from "./ConfirmDialog";
import PromptDialog from "./PromptDialog";

function noteName(path: string) {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/i, "");
}

function blurActive() {
  const el = document.activeElement;
  if (el instanceof HTMLElement) el.blur();
}

// Mobilens topbar over editoren: tilbage til listen, titel med gem-status,
// visning, Rediger/Færdig og en menu med Omdøb og Slet note
export default function MobileTopBar({ doc }: { doc: Doc }) {
  const view = useStore((s) => s.view);
  const editing = useStore((s) => s.editing);
  const syncStatus = useStore((s) => s.syncStatus);
  const lastSyncAt = useStore((s) => s.lastSyncAt);
  const [menuOpen, setMenuOpen] = useState(false);
  const [rename, setRename] = useState<{ value: string; error?: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // genrender løbende, så "lige nu" bliver til et klokkeslæt
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const name = noteName(doc.path);
  const status = saveStatusLabel(doc, platform, { compact: true, syncStatus, lastSyncAt });

  const back = () => {
    const s = useStore.getState();
    void s.saveNow(doc.path);
    blurActive();
    s.setEditing(false);
    s.setSidebarVisible(true);
  };

  const toggleEditing = () => {
    const s = useStore.getState();
    if (editing) {
      blurActive();
      void s.saveNow(doc.path);
    }
    s.setEditing(!editing);
  };

  const submitRename = (value: string) => {
    if (value === name) return;
    const path = doc.path;
    useStore
      .getState()
      .renameNote(path, value)
      .catch((e: unknown) => {
        // åbn dialogen igen med fejlen, så navnet kan rettes
        const message = e instanceof Error ? e.message : String(e);
        setRename({ value, error: message || "Noten kunne ikke omdøbes" });
      });
  };

  const remove = async () => {
    const s = useStore.getState();
    const path = doc.path;
    blurActive();
    s.setEditing(false);
    s.setSidebarVisible(true);
    try {
      // gem først: lukning af en note med ugemte ændringer skriver dem
      await s.saveNow(path);
      await s.removeNote(path);
    } catch {
      // noten blev ikke slettet og står stadig i listen
    }
  };

  return (
    <>
      <div className="mobile-topbar">
        <button className="mtb-back" onClick={back} aria-label="Tilbage til noterne">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 5-7 7 7 7" />
          </svg>
          Noter
        </button>
        <div className="mtb-title">
          <div className="mtb-name">{name}</div>
          <div className={"mtb-status" + (status.accent ? " accent" : "")}>{status.text}</div>
        </div>
        <div className="mtb-actions">
          <div className="view-switcher compact">
            <button
              className={"segment segment-layout" + (view === "layout" ? " active" : "")}
              aria-label="Layout-visning"
              onClick={() => useStore.getState().setView("layout")}
            >
              Aa
            </button>
            <button
              className={"segment segment-markdown" + (view === "markdown" ? " active" : "")}
              aria-label="Markdown-visning"
              onClick={() => useStore.getState().setView("markdown")}
            >
              MD
            </button>
          </div>
          {!doc.missing && (
            <>
              <button
                className={"mtb-btn" + (editing ? " strong" : "")}
                onClick={toggleEditing}
              >
                {editing ? "Færdig" : "Rediger"}
              </button>
              <button
                className="mtb-icon"
                aria-label="Flere handlinger"
                onClick={() => {
                  blurActive();
                  setMenuOpen(true);
                }}
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                  <circle cx="5" cy="12" r="1.8" />
                  <circle cx="12" cy="12" r="1.8" />
                  <circle cx="19" cy="12" r="1.8" />
                </svg>
              </button>
            </>
          )}
        </div>
      </div>
      {/* uden for topbaren, som ikke må kunne markeres (user-select: none) */}
      {menuOpen && (
        <ContextMenu
          sheet
          title={name}
          items={[
            { label: "Omdøb", action: () => setRename({ value: name }) },
            { label: "Slet note", danger: true, action: () => setConfirmDelete(true) },
          ]}
          onClose={() => setMenuOpen(false)}
        />
      )}
      {rename && (
        <PromptDialog
          title="Omdøb note"
          placeholder="Nyt navn"
          submitLabel="Omdøb"
          initialValue={rename.value}
          error={rename.error}
          onClose={() => setRename(null)}
          onSubmit={submitRename}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title="Slet note?"
          text={deleteText(name)}
          confirmLabel="Slet"
          onClose={() => setConfirmDelete(false)}
          onConfirm={() => void remove()}
        />
      )}
    </>
  );
}

export function deleteText(name: string): string {
  return platform === "web"
    ? `»${name}« slettes her og fra GitHub ved næste synk. Den kan findes igen i historikken på GitHub.`
    : `»${name}« lægges i papirkurven.`;
}
