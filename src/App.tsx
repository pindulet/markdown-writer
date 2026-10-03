import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  frontendReady,
  onFsChange,
  onOpenFile,
  pickFolder as pickFolderDialog,
  platform,
} from "./backend";
import { useStore } from "./store";
import { isMobileNow, sidebarOnLayoutSwitch, useIsMobile } from "./useIsMobile";
import WebGate from "./web/WebGate";
import Sidebar from "./components/Sidebar";
import MobileTopBar from "./components/MobileTopBar";
import FormatToolbar from "./components/FormatToolbar";
import TabBar from "./components/TabBar";
import MarkdownEditor from "./components/MarkdownEditor";
import LayoutEditor from "./components/LayoutEditor";
import StatusBar from "./components/StatusBar";
import Banners from "./components/Banners";
import NewNoteDialog from "./components/NewNoteDialog";
import PromptDialog from "./components/PromptDialog";
import ShortcutsDialog from "./components/ShortcutsDialog";
import Notice from "./components/Notice";

// Mobil: husk i sessionen, om editoren var åben, så en genindlæsning (fx når
// appen opdateres) lander samme sted. En kold start viser altid listen.
const MOBILE_EDITOR_KEY = "mw.mobileEditor";
// telefonen holder højst så mange noter åbne (der er ingen faner at lukke dem i)
const MOBILE_MAX_DOCS = 5;

function readMobileEditorFlag(): boolean {
  try {
    return sessionStorage.getItem(MOBILE_EDITOR_KEY) === "1";
  } catch {
    return false;
  }
}

function writeMobileEditorFlag(open: boolean) {
  try {
    sessionStorage.setItem(MOBILE_EDITOR_KEY, open ? "1" : "0");
  } catch {
    // ikke kritisk
  }
}

export default function App() {
  return platform === "web" ? (
    <WebGate>
      <AppShell />
    </WebGate>
  ) : (
    <AppShell />
  );
}

function AppShell() {
  const folder = useStore((s) => s.folder);
  const tabs = useStore((s) => s.tabs);
  const activePath = useStore((s) => s.activePath);
  const doc = useStore((s) => (s.activePath ? s.docs[s.activePath] : undefined));
  const view = useStore((s) => s.view);
  const sidebarVisible = useStore((s) => s.sidebarVisible);
  const newNoteOpen = useStore((s) => s.newNoteOpen);
  const newFolderParent = useStore((s) => s.newFolderParent);
  const shortcutsOpen = useStore((s) => s.shortcutsOpen);
  const aiKeyDialogOpen = useStore((s) => s.aiKeyDialogOpen);
  const editing = useStore((s) => s.editing);
  const mobile = useIsMobile();
  const [restoreEditor] = useState(readMobileEditorFlag);
  const [sessionReady, setSessionReady] = useState(false);

  useEffect(() => {
    void useStore
      .getState()
      .init()
      .then(() => {
        const s = useStore.getState();
        if (restoreEditor && isMobileNow() && s.activePath) s.setSidebarVisible(false);
        setSessionReady(true);
      })
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

  // Git-synk: hent ændringer fra GitHub med jævne mellemrum og når
  // vinduet får fokus igen (fx efter redigering på telefonen/webben).
  // På web styrer WebGate synk efter appens livscyklus.
  useEffect(() => {
    if (platform === "web") return;
    const id = window.setInterval(() => {
      void useStore.getState().syncNow();
    }, 5 * 60_000);
    const onFocus = () => {
      const s = useStore.getState();
      if (s.lastSyncAt === null || Date.now() - s.lastSyncAt > 60_000) {
        void s.syncNow();
      }
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
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
      } else if (e.key === "+" || (e.key === "=" && !e.shiftKey)) {
        // "=" er plus-tasten uden shift på amerikansk layout
        e.preventDefault();
        s.setZoom(s.zoom + 0.1);
      } else if (e.key === "-") {
        e.preventDefault();
        s.setZoom(s.zoom - 0.1);
      } else if (e.code === "Digit0" && e.shiftKey) {
        e.preventDefault();
        s.setZoom(1);
      } else if (e.key.toLowerCase() === "j" && e.shiftKey) {
        // ⇧⌘A ville kollidere med webviewets "markér alt"
        e.preventDefault();
        s.toggleAi();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const showMobileEditor = mobile && !sidebarVisible && !!doc;

  useEffect(() => {
    if (mobile && sessionReady) writeMobileEditorFlag(showMobileEditor);
  }, [mobile, sessionReady, showMobileEditor]);

  // Mobil: luk de ældste noter uden ugemte ændringer, når der er for mange åbne
  useEffect(() => {
    if (!mobile) return;
    const s = useStore.getState();
    let excess = s.tabs.length - MOBILE_MAX_DOCS;
    for (const path of s.tabs) {
      if (excess <= 0) break;
      const d = s.docs[path];
      if (path === s.activePath || (d && (d.dirty || d.conflict !== null))) continue;
      s.closeTab(path);
      excess -= 1;
    }
  }, [mobile, tabs]);

  // skift mellem mobil- og desktoplayout (fx en iPad i Split View): vis
  // kolonnen på desktop, og land i den samme note, når der skiftes tilbage.
  // Før maling, så det forkerte layout ikke når at blinke.
  const wasMobile = useRef(mobile);
  const layoutMemo = useRef({ reopenNote: false });
  useLayoutEffect(() => {
    if (wasMobile.current === mobile) return;
    wasMobile.current = mobile;
    const s = useStore.getState();
    const next = sidebarOnLayoutSwitch(
      mobile,
      { sidebarVisible: s.sidebarVisible, hasNote: !!(s.activePath && s.docs[s.activePath]) },
      layoutMemo.current
    );
    if (next !== null) s.setSidebarVisible(next);
  }, [mobile]);

  const rootClass = "app" + (mobile ? " mobile" : "") + " platform-" + platform;

  const pickFolder = async () => {
    const selected = await pickFolderDialog();
    if (selected) {
      await useStore.getState().setFolder(selected);
    }
  };

  if (!folder) {
    // på web viser WebGate opsætningen; mappen sættes, når forbindelsen er klar
    if (platform === "web") return <div className={rootClass} />;
    return (
      <div className={rootClass}>
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

  const dialogs = (
    <>
      {newNoteOpen && (
        <NewNoteDialog onClose={() => useStore.getState().setNewNoteOpen(false)} />
      )}
      {newFolderParent !== null && (
        <PromptDialog
          title={
            newFolderParent
              ? `Ny mappe i ${newFolderParent.replaceAll("/", " / ")}`
              : "Ny mappe"
          }
          placeholder="Navn på mappen"
          submitLabel="Opret"
          onClose={() => useStore.getState().setNewFolderParent(null)}
          onSubmit={(name) => void useStore.getState().newFolder(name)}
        />
      )}
      {shortcutsOpen && (
        <ShortcutsDialog onClose={() => useStore.getState().setShortcutsOpen(false)} />
      )}
      {aiKeyDialogOpen && (
        <PromptDialog
          title="Anthropic API-nøgle"
          placeholder="sk-ant-…"
          submitLabel="Gem"
          inputType="password"
          onClose={() => useStore.getState().setAiKeyDialogOpen(false)}
          onSubmit={(key) => void useStore.getState().saveAiKey(key)}
        />
      )}
    </>
  );

  if (mobile) {
    // Mobil: enten notelisten eller én note i fuld skærm
    return (
      <div className={rootClass}>
        {!showMobileEditor || !doc ? (
          <>
            <Sidebar onPickFolder={() => void pickFolder()} />
            <Notice above=".sidebar-footer" />
          </>
        ) : (
          <div className="main">
            <MobileTopBar doc={doc} />
            {!doc.missing && <Banners doc={doc} />}
            <div className="editor-area">
              {doc.missing ? (
                <div className="editor-empty">
                  <div>
                    {platform === "web"
                      ? "Noten findes ikke længere."
                      : "Filen findes ikke længere på disken."}
                  </div>
                  <button
                    className="secondary-btn"
                    onClick={() => {
                      const s = useStore.getState();
                      s.closeTab(doc.path);
                      s.setSidebarVisible(true);
                    }}
                  >
                    Tilbage til noterne
                  </button>
                </div>
              ) : view === "markdown" ? (
                <MarkdownEditor key={activePath} doc={doc} />
              ) : (
                <LayoutEditor key={activePath} doc={doc} />
              )}
            </div>
            <Notice />
            {editing && !doc.missing && <FormatToolbar />}
          </div>
        )}
        {dialogs}
      </div>
    );
  }

  return (
    <div className={rootClass}>
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
        <Notice />
        <StatusBar doc={doc} />
      </div>
      {dialogs}
    </div>
  );
}
