import { create } from "zustand";
import * as fsApi from "./backend";

export type ViewMode = "markdown" | "layout";

export interface Doc {
  path: string;
  content: string;
  dirty: boolean;
  claudeUpdated: boolean; // ekstern ændring, endnu ikke set (prik på fane/fil)
  showExternalBanner: boolean;
  prevContent: string | null; // indhold før seneste eksterne opdatering (Fortryd)
  conflict: string | null; // diskens indhold, når vi selv har ugemte ændringer
  lastSavedAt: number | null;
  lastExternalAt: number | null;
  missing: boolean;
}

interface Store {
  folder: string | null;
  files: fsApi.FileEntry[];
  dirs: string[];
  tabs: string[];
  activePath: string | null;
  docs: Record<string, Doc>;
  view: ViewMode;
  sidebarVisible: boolean;
  changedFiles: Record<string, true>;
  newNoteOpen: boolean;
  newNoteDir: string; // forvalgt undermappe (rel_dir), "" = rodmappen
  newFolderParent: string | null; // null = lukket, "" = rodmappen, ellers rel_dir
  shortcutsOpen: boolean;

  init: () => Promise<void>;
  setFolder: (path: string) => Promise<void>;
  refreshFiles: () => Promise<void>;
  openFile: (path: string) => Promise<void>;
  openExternalFile: (path: string) => Promise<void>;
  activate: (path: string) => void;
  closeTab: (path: string) => void;
  editContent: (path: string, content: string) => void;
  saveNow: (path: string) => Promise<void>;
  handleFsChange: (paths: string[]) => Promise<void>;
  resolveConflict: (path: string, keepMine: boolean) => Promise<void>;
  undoExternal: (path: string) => Promise<void>;
  dismissExternalBanner: (path: string) => void;
  setView: (view: ViewMode) => void;
  toggleView: () => void;
  toggleSidebar: () => void;
  setNewNoteOpen: (open: boolean, dir?: string) => void;
  setNewFolderParent: (parent: string | null) => void;
  setShortcutsOpen: (open: boolean) => void;
  newNote: (name: string, relDir: string) => Promise<void>;
  newFolder: (name: string) => Promise<void>;
  renameNote: (path: string, newName: string) => Promise<void>;
  removeNote: (path: string) => Promise<void>;
}

const saveTimers = new Map<string, number>();
let refreshTimer: number | null = null;

function newDoc(path: string, content: string): Doc {
  return {
    path,
    content,
    dirty: false,
    claudeUpdated: false,
    showExternalBanner: false,
    prevContent: null,
    conflict: null,
    lastSavedAt: null,
    lastExternalAt: null,
    missing: false,
  };
}

function persistSession(state: {
  folder: string | null;
  tabs: string[];
  activePath: string | null;
  view: ViewMode;
}) {
  try {
    if (state.folder) localStorage.setItem("mw.folder", state.folder);
    localStorage.setItem("mw.tabs", JSON.stringify(state.tabs));
    localStorage.setItem("mw.active", state.activePath ?? "");
    localStorage.setItem("mw.view", state.view);
  } catch {
    // localStorage kan fejle i sjældne tilfælde; sessionen er ikke kritisk
  }
}

export const useStore = create<Store>((set, get) => ({
  folder: null,
  files: [],
  dirs: [],
  tabs: [],
  activePath: null,
  docs: {},
  view: "layout",
  sidebarVisible: true,
  changedFiles: {},
  newNoteOpen: false,
  newNoteDir: "",
  newFolderParent: null,
  shortcutsOpen: false,

  init: async () => {
    let folder: string | null = null;
    let tabs: string[] = [];
    let active: string | null = null;
    let view: ViewMode = "layout";
    try {
      folder = localStorage.getItem("mw.folder");
      tabs = JSON.parse(localStorage.getItem("mw.tabs") ?? "[]");
      active = localStorage.getItem("mw.active") || null;
      const v = localStorage.getItem("mw.view");
      if (v === "markdown" || v === "layout") view = v;
    } catch {
      // ignorer korrupt session
    }
    set({ view });
    if (!folder) return;
    try {
      await get().setFolder(folder);
    } catch {
      return; // mappen findes ikke længere
    }
    for (const path of tabs) {
      try {
        await get().openFile(path);
      } catch {
        // filen er væk; spring over
      }
    }
    const state = get();
    if (active && state.tabs.includes(active)) {
      set({ activePath: active });
    }
  },

  setFolder: async (path: string) => {
    const listing = await fsApi.listFolder(path);
    await fsApi.watchFolder(path);
    set({ folder: path, files: listing.files, dirs: listing.dirs, changedFiles: {} });
    persistSession({ ...get() });
  },

  refreshFiles: async () => {
    const { folder } = get();
    if (!folder) return;
    try {
      const listing = await fsApi.listFolder(folder);
      set({ files: listing.files, dirs: listing.dirs });
    } catch {
      // mappen kan være midlertidigt utilgængelig
    }
  },

  openFile: async (path: string) => {
    const { tabs, docs } = get();
    if (tabs.includes(path)) {
      get().activate(path);
      return;
    }
    const content = await fsApi.readFile(path);
    set({
      tabs: [...tabs, path],
      docs: { ...docs, [path]: newDoc(path, content) },
    });
    get().activate(path);
  },

  // Fil åbnet fra Finder: pin filens mappe, hvis der ingen mappe er valgt
  openExternalFile: async (path: string) => {
    if (!get().folder) {
      const dir = path.slice(0, path.lastIndexOf("/"));
      if (dir) {
        try {
          await get().setFolder(dir);
        } catch {
          // mappen kunne ikke læses; åbn filen alligevel
        }
      }
    }
    await get().openFile(path);
  },

  activate: (path: string) => {
    const { docs, changedFiles } = get();
    const doc = docs[path];
    const nextChanged = { ...changedFiles };
    delete nextChanged[path];
    set({
      activePath: path,
      changedFiles: nextChanged,
      docs: doc ? { ...docs, [path]: { ...doc, claudeUpdated: false } } : docs,
    });
    persistSession({ ...get() });
  },

  closeTab: (path: string) => {
    const { tabs, docs, activePath } = get();
    const timer = saveTimers.get(path);
    if (timer) {
      window.clearTimeout(timer);
      saveTimers.delete(path);
    }
    const doc = docs[path];
    if (doc && doc.dirty && !doc.conflict && !doc.missing) {
      // gem synkront-ish før fanen lukkes
      fsApi.writeFile(path, doc.content).catch(() => {});
    }
    const idx = tabs.indexOf(path);
    const nextTabs = tabs.filter((t) => t !== path);
    const nextDocs = { ...docs };
    delete nextDocs[path];
    let nextActive = activePath;
    if (activePath === path) {
      nextActive = nextTabs[Math.min(idx, nextTabs.length - 1)] ?? null;
    }
    set({ tabs: nextTabs, docs: nextDocs, activePath: nextActive });
    persistSession({ ...get() });
  },

  editContent: (path: string, content: string) => {
    const { docs } = get();
    const doc = docs[path];
    if (!doc || doc.content === content) return;
    set({ docs: { ...docs, [path]: { ...doc, content, dirty: true } } });
    const existing = saveTimers.get(path);
    if (existing) window.clearTimeout(existing);
    saveTimers.set(
      path,
      window.setTimeout(() => {
        saveTimers.delete(path);
        void get().saveNow(path);
      }, 800)
    );
  },

  saveNow: async (path: string) => {
    const doc = get().docs[path];
    // gem aldrig hen over en uafklaret konflikt
    if (!doc || !doc.dirty || doc.conflict || doc.missing) return;
    try {
      await fsApi.writeFile(path, doc.content);
      const current = get().docs[path];
      if (!current) return;
      set({
        docs: {
          ...get().docs,
          [path]: {
            ...current,
            dirty: current.content !== doc.content,
            lastSavedAt: Date.now(),
          },
        },
      });
    } catch {
      // beholder dirty; næste redigering forsøger igen
    }
  },

  handleFsChange: async (paths: string[]) => {
    // opdater fillisten (debounced), uanset hvad der skete
    if (refreshTimer) window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      void get().refreshFiles();
    }, 300);

    const unique = Array.from(new Set(paths));
    for (const path of unique) {
      const doc = get().docs[path];
      if (!doc) {
        // ikke åben: markér med prik i sidebaren
        set({ changedFiles: { ...get().changedFiles, [path]: true } });
        continue;
      }
      let disk: string;
      try {
        disk = await fsApi.readFile(path);
      } catch {
        set({ docs: { ...get().docs, [path]: { ...doc, missing: true } } });
        continue;
      }
      const fresh = get().docs[path];
      if (!fresh) continue;
      if (disk === fresh.content) {
        // vores eget gem (eller ingen reel ændring)
        if (fresh.missing) {
          set({ docs: { ...get().docs, [path]: { ...fresh, missing: false } } });
        }
        continue;
      }
      if (!fresh.dirty) {
        // ingen ugemte ændringer: opdater lydløst og vis diskret besked
        const isActive = get().activePath === path;
        set({
          docs: {
            ...get().docs,
            [path]: {
              ...fresh,
              prevContent: fresh.content,
              content: disk,
              missing: false,
              claudeUpdated: !isActive,
              showExternalBanner: isActive,
              lastExternalAt: Date.now(),
            },
          },
        });
      } else {
        // konflikt: brugeren bestemmer
        set({
          docs: {
            ...get().docs,
            [path]: { ...fresh, conflict: disk, missing: false },
          },
        });
      }
    }
  },

  resolveConflict: async (path: string, keepMine: boolean) => {
    const doc = get().docs[path];
    if (!doc || doc.conflict === null) return;
    if (keepMine) {
      const mine = doc.content;
      set({
        docs: { ...get().docs, [path]: { ...doc, conflict: null, dirty: true } },
      });
      try {
        await fsApi.writeFile(path, mine);
        const current = get().docs[path];
        if (current) {
          set({
            docs: {
              ...get().docs,
              [path]: {
                ...current,
                dirty: current.content !== mine,
                lastSavedAt: Date.now(),
              },
            },
          });
        }
      } catch {
        // beholder dirty
      }
    } else {
      set({
        docs: {
          ...get().docs,
          [path]: {
            ...doc,
            prevContent: doc.content,
            content: doc.conflict,
            conflict: null,
            dirty: false,
            showExternalBanner: true,
            lastExternalAt: Date.now(),
          },
        },
      });
    }
  },

  undoExternal: async (path: string) => {
    const doc = get().docs[path];
    if (!doc || doc.prevContent === null) return;
    const restored = doc.prevContent;
    set({
      docs: {
        ...get().docs,
        [path]: {
          ...doc,
          content: restored,
          prevContent: null,
          showExternalBanner: false,
          claudeUpdated: false,
          dirty: false,
        },
      },
    });
    try {
      await fsApi.writeFile(path, restored);
    } catch {
      // næste redigering gemmer igen
    }
  },

  dismissExternalBanner: (path: string) => {
    const doc = get().docs[path];
    if (!doc) return;
    set({ docs: { ...get().docs, [path]: { ...doc, showExternalBanner: false } } });
  },

  setView: (view: ViewMode) => {
    set({ view });
    persistSession({ ...get() });
  },

  toggleView: () => {
    get().setView(get().view === "markdown" ? "layout" : "markdown");
  },

  toggleSidebar: () => set({ sidebarVisible: !get().sidebarVisible }),

  setNewNoteOpen: (open: boolean, dir?: string) =>
    set({ newNoteOpen: open, newNoteDir: dir ?? "" }),

  setNewFolderParent: (parent: string | null) => set({ newFolderParent: parent }),

  setShortcutsOpen: (open: boolean) => set({ shortcutsOpen: open }),

  newNote: async (name: string, relDir: string) => {
    const { folder } = get();
    if (!folder) return;
    const title = name.trim() || "Uden titel";
    const dir = relDir ? `${folder}/${relDir}` : folder;
    const path = await fsApi.createFile(dir, title);
    await get().refreshFiles();
    await get().openFile(path);
  },

  newFolder: async (name: string) => {
    const { folder, newFolderParent } = get();
    if (!folder || newFolderParent === null) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const parent = newFolderParent ? `${folder}/${newFolderParent}` : folder;
    await fsApi.createFolder(parent, trimmed);
    await get().refreshFiles();
  },

  renameNote: async (path: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const newPath = await fsApi.renameFile(path, trimmed);
    const { tabs, docs, activePath } = get();
    const doc = docs[path];
    const nextDocs = { ...docs };
    delete nextDocs[path];
    if (doc) nextDocs[newPath] = { ...doc, path: newPath };
    set({
      tabs: tabs.map((t) => (t === path ? newPath : t)),
      docs: nextDocs,
      activePath: activePath === path ? newPath : activePath,
    });
    await get().refreshFiles();
    persistSession({ ...get() });
  },

  removeNote: async (path: string) => {
    await fsApi.deleteFile(path);
    if (get().tabs.includes(path)) get().closeTab(path);
    await get().refreshFiles();
  },
}));
