import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { useStore } from "../store";
import { platform, type FileEntry } from "../backend";
import { useIsMobile } from "../useIsMobile";
import ContextMenu from "./ContextMenu";
import ConfirmDialog from "./ConfirmDialog";
import PromptDialog from "./PromptDialog";
import { deleteText } from "./MobileTopBar";
import SettingsSheet from "../web/SettingsSheet";

interface MenuState {
  x: number;
  y: number;
  kind: "file" | "folder" | "root";
  path: string; // absolut sti for filer, rel_dir for mapper, "" for roden
}

// Mobil: handlingsark efter et langt tryk på en note eller en mappe
interface SheetState {
  kind: "file" | "folder";
  path: string; // absolut sti for filer, rel_dir for mapper
  name: string;
}

const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 10;

// Mobil: listen afmonteres, mens en note er åben; søgning og rulleposition
// huskes, så man lander samme sted, når man går tilbage
let mobileQuery = "";
let mobileScrollTop = 0;

interface FolderNode {
  name: string;
  relPath: string;
  folders: FolderNode[];
  files: FileEntry[];
}

function buildTree(files: FileEntry[], dirs: string[]): FolderNode {
  const root: FolderNode = { name: "", relPath: "", folders: [], files: [] };
  const lookup = new Map<string, FolderNode>([["", root]]);
  const ensureDir = (relDir: string): FolderNode => {
    if (!relDir) return root;
    const parts = relDir.split("/");
    let node = root;
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      let child = lookup.get(acc);
      if (!child) {
        child = { name: part, relPath: acc, folders: [], files: [] };
        lookup.set(acc, child);
        node.folders.push(child);
      }
      node = child;
    }
    return node;
  };
  // alle mapper med — også dem uden noter i
  for (const d of dirs) ensureDir(d);
  for (const f of files) ensureDir(f.rel_dir).files.push(f);
  const sortNode = (node: FolderNode) => {
    node.folders.sort((a, b) => a.name.localeCompare(b.name, "da"));
    node.files.sort((a, b) => a.name.localeCompare(b.name, "da"));
    node.folders.forEach(sortNode);
  };
  sortNode(root);
  return root;
}

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem("mw.collapsed") ?? "[]"));
  } catch {
    return new Set();
  }
}

function timeLabel(ts: number) {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, "0")}.${d
    .getMinutes()
    .toString()
    .padStart(2, "0")}`;
}

function SyncRow({ mobile }: { mobile: boolean }) {
  const gitRepo = useStore((s) => s.gitRepo);
  const syncStatus = useStore((s) => s.syncStatus);
  const syncDetail = useStore((s) => s.syncDetail);
  const lastSyncAt = useStore((s) => s.lastSyncAt);
  const syncProgress = useStore((s) => s.syncProgress);
  if (!gitRepo && !syncProgress) return null;

  let label: string;
  let warn = false;
  switch (syncStatus) {
    case "syncing":
      label = "Synkroniserer …";
      break;
    case "ok":
      label = lastSyncAt ? `GitHub · synket ${timeLabel(lastSyncAt)}` : "GitHub · synket";
      break;
    case "offline":
      label = "Ingen forbindelse · gemt lokalt";
      warn = true;
      break;
    case "conflict":
      // en rebase/merge, nogen er i gang med uden for appen, røres ikke
      label = /er i gang i vaulten/.test(syncDetail)
        ? "Git-handling i gang — gør den færdig i terminalen"
        : "Konflikt — kunne ikke flette";
      warn = true;
      break;
    case "error":
      label = `Synk fejlede — ${mobile ? "tryk" : "klik"} for at prøve igen`;
      warn = true;
      break;
    default:
      label = "Synkronisér med GitHub";
  }
  if (syncProgress) {
    label = `Henter noter … ${syncProgress.done} af ${syncProgress.total}`;
    warn = false;
  }
  // på en telefon findes ingen tooltip; vis forklaringen under rækken
  const showDetail =
    mobile && !syncProgress && (syncStatus === "error" || syncStatus === "conflict") && syncDetail;

  const button = (
    <button
      className={"sync-btn" + (warn ? " warn" : "")}
      title={syncDetail ? syncDetail.slice(0, 500) : "Synkronisér nu"}
      onClick={() => void useStore.getState().syncNow()}
    >
      <svg
        className={syncStatus === "syncing" || syncProgress ? "sync-spin" : ""}
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21 12a9 9 0 1 1-2.64-6.36" />
        <path d="M21 3v6h-6" />
      </svg>
      <span className="sync-label">{label}</span>
    </button>
  );
  if (!showDetail) return button;
  return (
    <>
      {button}
      <div className="sync-detail">{syncDetail.slice(0, 300)}</div>
    </>
  );
}

// nøgle for "Senest åbnet" blandt de sammenklappede mapper (":" findes ikke i mappenavne)
const RECENT_KEY = ":senest";

export default function Sidebar({ onPickFolder }: { onPickFolder: () => void }) {
  const files = useStore((s) => s.files);
  const dirs = useStore((s) => s.dirs);
  const folder = useStore((s) => s.folder);
  const activePath = useStore((s) => s.activePath);
  const docs = useStore((s) => s.docs);
  const changedFiles = useStore((s) => s.changedFiles);
  const recent = useStore((s) => s.recent);
  const mobile = useIsMobile();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [query, setQueryState] = useState(() => (mobile ? mobileQuery : ""));
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [mobileRename, setMobileRename] = useState<
    { path: string; name: string; value: string; error?: string } | null
  >(null);
  const [confirmDelete, setConfirmDelete] = useState<SheetState | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const suppressClick = useRef(false);

  const tree = useMemo(() => buildTree(files, dirs), [files, dirs]);

  // genveje til de senest åbnede noter, der stadig findes i mappen
  const recentFiles = useMemo(() => {
    const byPath = new Map(files.map((f) => [f.path, f]));
    return recent.map((p) => byPath.get(p)).filter((f): f is FileEntry => f !== undefined);
  }, [files, recent]);

  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return files
      .filter((f) => f.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name, "da"));
  }, [files, query]);

  const folderName = folder?.split("/").filter(Boolean).pop() ?? "Noter";

  const setQuery = (q: string) => {
    setQueryState(q);
    if (mobile) mobileQuery = q;
  };

  const hasDot = (path: string) =>
    changedFiles[path] === true || docs[path]?.claudeUpdated === true;

  const folderHasDot = (node: FolderNode): boolean =>
    node.files.some((f) => hasDot(f.path)) || node.folders.some(folderHasDot);

  const toggleFolder = (relPath: string) => {
    const next = new Set(collapsed);
    if (next.has(relPath)) next.delete(relPath);
    else next.add(relPath);
    setCollapsed(next);
    try {
      localStorage.setItem("mw.collapsed", JSON.stringify(Array.from(next)));
    } catch {
      // ikke kritisk
    }
  };

  const startRename = (path: string) => {
    const entry = files.find((f) => f.path === path);
    setRenameValue(entry?.name ?? "");
    setRenaming(path);
    setMenu(null);
  };

  const commitRename = async () => {
    if (renaming && renameValue.trim()) {
      try {
        await useStore.getState().renameNote(renaming, renameValue);
      } catch {
        // navnet var optaget eller ugyldigt; behold det gamle
      }
    }
    setRenaming(null);
  };

  // Mobil: noten åbnes i læsetilstand og fylder hele skærmen
  const openNote = (path: string) => {
    const s = useStore.getState();
    if (!mobile) {
      void s.openFile(path);
      return;
    }
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    s.setEditing(false);
    void s.openFile(path).then(
      () => useStore.getState().setSidebarVisible(false),
      () => {} // filen er væk; bliv i listen
    );
  };

  const cancelPress = () => {
    if (press.current) {
      window.clearTimeout(press.current.timer);
      press.current = null;
    }
  };

  // rulleposition gendannes, før listen tegnes
  useLayoutEffect(() => {
    if (mobile && listRef.current) listRef.current.scrollTop = mobileScrollTop;
    return () => cancelPress();
  }, []);

  // Langt tryk (mobil): iOS sender ingen contextmenu-event
  const longPress = (open: () => void) =>
    mobile
      ? {
          onTouchStart: (e: React.TouchEvent) => {
            cancelPress();
            suppressClick.current = false;
            if (e.touches.length !== 1) return;
            const t = e.touches[0];
            press.current = {
              x: t.clientX,
              y: t.clientY,
              timer: window.setTimeout(() => {
                press.current = null;
                suppressClick.current = true;
                open();
              }, LONG_PRESS_MS),
            };
          },
          onTouchMove: (e: React.TouchEvent) => {
            const p = press.current;
            const t = e.touches[0];
            if (p && t && Math.hypot(t.clientX - p.x, t.clientY - p.y) > LONG_PRESS_SLOP_PX) {
              cancelPress();
            }
          },
          onTouchEnd: (e: React.TouchEvent) => {
            cancelPress();
            // klikket efter et langt tryk må ikke også åbne noten
            if (suppressClick.current && e.cancelable) e.preventDefault();
          },
          onTouchCancel: cancelPress,
        }
      : {};

  const clickGuard = (action: () => void) => () => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    action();
  };

  const mobileContextMenu = (open: () => void) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    cancelPress();
    open();
  };

  const submitMobileRename = (path: string, name: string, value: string) => {
    if (value === name) return;
    useStore
      .getState()
      .renameNote(path, value)
      .catch((e: unknown) => {
        // åbn dialogen igen med fejlen, så navnet kan rettes
        const message = e instanceof Error ? e.message : String(e);
        setMobileRename({ path, name, value, error: message || "Noten kunne ikke omdøbes" });
      });
  };

  const removeFromSheet = async (path: string) => {
    const s = useStore.getState();
    try {
      // gem først: lukning af en note med ugemte ændringer skriver dem
      await s.saveNow(path);
      await s.removeNote(path);
    } catch {
      // noten blev ikke slettet og står stadig i listen
    }
  };

  const renderFile = (f: FileEntry, depth: number) => {
    if (renaming === f.path) {
      return (
        <input
          key={f.path}
          className="rename-input"
          style={{ marginLeft: depth * 14 }}
          autoFocus
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={() => void commitRename()}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commitRename();
            if (e.key === "Escape") setRenaming(null);
          }}
        />
      );
    }
    const openSheet = () => setSheet({ kind: "file", path: f.path, name: f.name });
    return (
      <div
        key={f.path}
        className={"file-row" + (f.path === activePath ? " active" : "")}
        style={{ paddingLeft: 10 + depth * 14 }}
        onClick={clickGuard(() => openNote(f.path))}
        onContextMenu={
          mobile
            ? mobileContextMenu(openSheet)
            : (e) => {
                e.preventDefault();
                e.stopPropagation();
                setMenu({ x: e.clientX, y: e.clientY, kind: "file", path: f.path });
              }
        }
        {...longPress(openSheet)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
        </svg>
        <span className="file-name">{f.name}</span>
        {hasDot(f.path) && <span className="claude-dot" />}
      </div>
    );
  };

  const renderFolder = (node: FolderNode, depth: number) => {
    const isCollapsed = collapsed.has(node.relPath);
    const openSheet = () => setSheet({ kind: "folder", path: node.relPath, name: node.name });
    return (
      <div key={node.relPath}>
        <div
          className="folder-row"
          style={{ paddingLeft: 10 + depth * 14 }}
          onClick={clickGuard(() => toggleFolder(node.relPath))}
          onContextMenu={
            mobile
              ? mobileContextMenu(openSheet)
              : (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setMenu({ x: e.clientX, y: e.clientY, kind: "folder", path: node.relPath });
                }
          }
          {...longPress(openSheet)}
        >
          <svg
            className={"chevron" + (isCollapsed ? "" : " open")}
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m9 6 6 6-6 6" />
          </svg>
          <span className="file-name">{node.name}</span>
          {isCollapsed && folderHasDot(node) && <span className="claude-dot" />}
        </div>
        {!isCollapsed && (
          <div>
            {node.folders.map((child) => renderFolder(child, depth + 1))}
            {node.files.map((f) => renderFile(f, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="sidebar" onClick={() => setMenu(null)}>
      <div className="traffic-space" data-tauri-drag-region />
      <div className="sidebar-header" data-tauri-drag-region>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
        <span className="sidebar-title">{folderName.toUpperCase()}</span>
        <span className="flex-spacer" />
        {platform === "web" ? (
          <button
            className="icon-btn settings-btn"
            title="Indstillinger"
            aria-label="Indstillinger"
            onClick={() => setSettingsOpen(true)}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        ) : (
          <button className="icon-btn" title="Skift mappe" onClick={onPickFolder}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 17v5" />
              <path d="M9 3h6l1 6 3 3H5l3-3z" />
            </svg>
          </button>
        )}
      </div>
      <div className="search-box">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <input
          className="search-input"
          value={query}
          placeholder="Søg i noter"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setQuery("");
            // mobil: Søg-tasten lukker tastaturet, så resultaterne kan ses
            if (e.key === "Enter" && mobile) e.currentTarget.blur();
          }}
          {...(mobile
            ? { autoCapitalize: "none", autoCorrect: "off", enterKeyHint: "search" as const }
            : {})}
        />
        {query && (
          <button className="icon-btn" title="Ryd søgning" onClick={() => setQuery("")}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
      <div
        className="file-list"
        ref={listRef}
        onScroll={
          mobile
            ? (e) => {
                mobileScrollTop = e.currentTarget.scrollTop;
              }
            : undefined
        }
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, kind: "root", path: "" });
        }}
      >
        {searchResults ? (
          searchResults.length === 0 ? (
            <div className="search-empty">Ingen noter matcher</div>
          ) : (
            searchResults.map((f) => (
              <div key={f.path}>
                {renderFile(f, 0)}
                {f.rel_dir && <div className="search-hint">{f.rel_dir}</div>}
              </div>
            ))
          )
        ) : (
          <div>
            {recentFiles.length > 0 && (
              <div className="recent-section">
                <div
                  className="folder-row"
                  style={{ paddingLeft: 10 }}
                  onClick={clickGuard(() => toggleFolder(RECENT_KEY))}
                >
                  <svg
                    className={"chevron" + (collapsed.has(RECENT_KEY) ? "" : " open")}
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="m9 6 6 6-6 6" />
                  </svg>
                  <span className="file-name">Senest åbnet</span>
                </div>
                {!collapsed.has(RECENT_KEY) &&
                  // omdøbes noten, står feltet kun i træet nedenfor
                  recentFiles.filter((f) => f.path !== renaming).map((f) => renderFile(f, 1))}
              </div>
            )}
            {tree.folders.map((child) => renderFolder(child, 0))}
            {tree.files.map((f) => renderFile(f, 0))}
          </div>
        )}
      </div>
      <div className="sidebar-footer">
        <button
          className="new-note-btn"
          onClick={() => useStore.getState().setNewNoteOpen(true)}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Ny note
        </button>
        <SyncRow mobile={mobile} />
      </div>
      {menu && (
        <div
          className="context-menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {menu.kind === "file" ? (
            <>
              <div className="context-item" onClick={() => startRename(menu.path)}>
                Omdøb
              </div>
              <div
                className="context-item danger"
                onClick={() => {
                  void useStore.getState().removeNote(menu.path);
                  setMenu(null);
                }}
              >
                Læg i papirkurven
              </div>
            </>
          ) : (
            <>
              <div
                className="context-item"
                onClick={() => {
                  useStore.getState().setNewNoteOpen(true, menu.path);
                  setMenu(null);
                }}
              >
                Ny note
              </div>
              <div
                className="context-item"
                onClick={() => {
                  useStore.getState().setNewFolderParent(menu.path);
                  setMenu(null);
                }}
              >
                Ny mappe
              </div>
            </>
          )}
        </div>
      )}
      {sheet && (
        <ContextMenu
          sheet
          title={sheet.name}
          items={
            sheet.kind === "file"
              ? [
                  {
                    label: "Omdøb",
                    action: () =>
                      setMobileRename({ path: sheet.path, name: sheet.name, value: sheet.name }),
                  },
                  { label: "Slet note", danger: true, action: () => setConfirmDelete(sheet) },
                ]
              : [
                  {
                    label: "Ny note her",
                    action: () => useStore.getState().setNewNoteOpen(true, sheet.path),
                  },
                  {
                    label: "Ny mappe",
                    action: () => useStore.getState().setNewFolderParent(sheet.path),
                  },
                ]
          }
          onClose={() => setSheet(null)}
        />
      )}
      {mobileRename && (
        <PromptDialog
          title="Omdøb note"
          placeholder="Nyt navn"
          submitLabel="Omdøb"
          initialValue={mobileRename.value}
          error={mobileRename.error}
          onClose={() => setMobileRename(null)}
          onSubmit={(value) =>
            submitMobileRename(mobileRename.path, mobileRename.name, value)
          }
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title="Slet note?"
          text={deleteText(confirmDelete.name)}
          confirmLabel="Slet"
          onClose={() => setConfirmDelete(null)}
          onConfirm={() => void removeFromSheet(confirmDelete.path)}
        />
      )}
      {settingsOpen && <SettingsSheet onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
