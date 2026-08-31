import { useMemo, useState } from "react";
import { useStore } from "../store";
import type { FileEntry } from "../backend";

interface MenuState {
  x: number;
  y: number;
  kind: "file" | "folder" | "root";
  path: string; // absolut sti for filer, rel_dir for mapper, "" for roden
}

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

export default function Sidebar({ onPickFolder }: { onPickFolder: () => void }) {
  const files = useStore((s) => s.files);
  const dirs = useStore((s) => s.dirs);
  const folder = useStore((s) => s.folder);
  const activePath = useStore((s) => s.activePath);
  const docs = useStore((s) => s.docs);
  const changedFiles = useStore((s) => s.changedFiles);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);

  const tree = useMemo(() => buildTree(files, dirs), [files, dirs]);

  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return files
      .filter((f) => f.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name, "da"));
  }, [files, query]);

  const folderName = folder?.split("/").filter(Boolean).pop() ?? "Noter";

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

  const renderFile = (f: FileEntry, depth: number) =>
    renaming === f.path ? (
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
    ) : (
      <div
        key={f.path}
        className={"file-row" + (f.path === activePath ? " active" : "")}
        style={{ paddingLeft: 10 + depth * 14 }}
        onClick={() => void useStore.getState().openFile(f.path)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY, kind: "file", path: f.path });
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
        </svg>
        <span className="file-name">{f.name}</span>
        {hasDot(f.path) && <span className="claude-dot" />}
      </div>
    );

  const renderFolder = (node: FolderNode, depth: number) => {
    const isCollapsed = collapsed.has(node.relPath);
    return (
      <div key={node.relPath}>
        <div
          className="folder-row"
          style={{ paddingLeft: 10 + depth * 14 }}
          onClick={() => toggleFolder(node.relPath)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setMenu({ x: e.clientX, y: e.clientY, kind: "folder", path: node.relPath });
          }}
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
        <button className="icon-btn" title="Skift mappe" onClick={onPickFolder}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 17v5" />
            <path d="M9 3h6l1 6 3 3H5l3-3z" />
          </svg>
        </button>
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
          }}
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
    </div>
  );
}
