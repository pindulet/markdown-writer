import { useEffect } from "react";
import {
  frontendReady,
  onFsChange,
  onOpenFile,
  pickFolder as pickFolderDialog,
} from "./backend";
import { useStore } from "./store";
import Sidebar from "./components/Sidebar";
import TabBar from "./components/TabBar";
import MarkdownEditor from "./components/MarkdownEditor";
import LayoutEditor from "./components/LayoutEditor";
import StatusBar from "./components/StatusBar";
import Banners from "./components/Banners";
import PromptDialog from "./components/PromptDialog";
import ShortcutsDialog from "./components/ShortcutsDialog";

export default function App() {
  const folder = useStore((s) => s.folder);
  const tabs = useStore((s) => s.tabs);
  const activePath = useStore((s) => s.activePath);
  const doc = useStore((s) => (s.activePath ? s.docs[s.activePath] : undefined));
  const view = useStore((s) => s.view);
  const sidebarVisible = useStore((s) => s.sidebarVisible);
  const newNoteOpen = useStore((s) => s.newNoteOpen);
  const shortcutsOpen = useStore((s) => s.shortcutsOpen);

  useEffect(() => {
    void useStore
      .getState()
      .init()
      .then(() => frontendReady())
      .then(async (pending) => {
        for (const path of pending) {
          await useStore.getState().openExternalFile(path);
        }
      });
    const unlistenFs = onFsChange((paths) => {
      void useStore.getState().handleFsChange(paths);
    });
    const unlistenOpen = onOpenFile(async (paths) => {
      for (const path of paths) {
        await useStore.getState().openExternalFile(path);
      }
    });
    return () => {
      unlistenFs();
      unlistenOpen();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey) return;
      const s = useStore.getState();
      if (e.key === "e") {
        e.preventDefault();
        s.toggleView();
      } else if (e.key === "\\") {
        e.preventDefault();
        s.toggleSidebar();
      } else if (e.key === "n") {
        e.preventDefault();
        if (s.folder) s.setNewNoteOpen(true);
      } else if (e.key === "/") {
        e.preventDefault();
        s.setShortcutsOpen(!s.shortcutsOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const pickFolder = async () => {
    const selected = await pickFolderDialog();
    if (selected) {
      await useStore.getState().setFolder(selected);
    }
  };

  if (!folder) {
    return (
      <div className="app">
        <div className="empty-state" data-tauri-drag-region>
          <div className="empty-title">Markdown Writer</div>
          <div className="empty-text">
            Vælg den mappe, hvor dine noter ligger. Den vises altid i venstre
            kolonne.
          </div>
          <button className="primary-btn" onClick={() => void pickFolder()}>
            Vælg mappe …
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      {sidebarVisible && <Sidebar onPickFolder={() => void pickFolder()} />}
      <div className="main">
        <TabBar sidebarHidden={!sidebarVisible} />
        {doc && !doc.missing && <Banners doc={doc} />}
        <div className="editor-area">
          {!doc && (
            <div className="editor-empty" data-tauri-drag-region>
              {tabs.length === 0
                ? "Vælg en note i venstre kolonne, eller opret en ny med ⌘N"
                : ""}
            </div>
          )}
          {doc && doc.missing && (
            <div className="editor-empty">
              <div>Filen findes ikke længere på disken.</div>
              <button
                className="secondary-btn"
                onClick={() => useStore.getState().closeTab(doc.path)}
              >
                Luk fane
              </button>
            </div>
          )}
          {doc && !doc.missing && view === "markdown" && (
            <MarkdownEditor key={activePath} doc={doc} />
          )}
          {doc && !doc.missing && view === "layout" && (
            <LayoutEditor key={activePath} doc={doc} />
          )}
        </div>
        <StatusBar doc={doc} />
      </div>
      {newNoteOpen && (
        <PromptDialog
          title="Ny note"
          placeholder="Titel på noten"
          submitLabel="Opret"
          onClose={() => useStore.getState().setNewNoteOpen(false)}
          onSubmit={(name) => void useStore.getState().newNote(name)}
        />
      )}
      {shortcutsOpen && (
        <ShortcutsDialog onClose={() => useStore.getState().setShortcutsOpen(false)} />
      )}
    </div>
  );
}
