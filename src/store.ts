import { create } from "zustand";
import * as fsApi from "./backend";
import { mergeThreeWay } from "./diff";

export type ViewMode = "markdown" | "layout";

// null = endnu ikke synket i denne session
export type SyncStatus = "syncing" | "ok" | "offline" | "conflict" | "error" | null;

export interface Doc {
  path: string;
  content: string;
  baseContent: string; // seneste indhold, editor og disk var enige om (til fletning)
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
  gitRepo: boolean; // den valgte mappe er et git-repo
  syncStatus: SyncStatus;
  syncDetail: string;
  lastSyncAt: number | null;

  init: () => Promise<void>;
  setFolder: (path: string) => Promise<void>;
  refreshFiles: () => Promise<void>;
  openFile: (path: string) => Promise<void>;
  openExternalFile: (path: string) => Promise<void>;
  openWikilink: (target: string) => Promise<void>;
  activate: (path: string) => void;
  closeTab: (path: string) => void;
  editContent: (path: string, content: string) => void;
  saveNow: (path: string) => Promise<void>;
  handleFsChange: (paths: string[]) => Promise<void>;
  resolveConflict: (path: string, keepMine: boolean) => Promise<void>;
  mergeConflict: (path: string) => Promise<void>;
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
  scheduleSync: () => void;
  syncNow: () => Promise<void>;
}

const saveTimers = new Map<string, number>();
let refreshTimer: number | null = null;

// Seneste indhold, vi selv har skrevet pr. fil. Watcher-events for vores
// egne skrivninger kan ankomme, EFTER brugeren har tastet videre — uden
// dette register ville appens eget gem ligne en ekstern ændring og give
// en falsk konflikt.
const lastWritten = new Map<string, string>();

async function writeOwn(path: string, content: string): Promise<void> {
  lastWritten.set(path, content);
  await fsApi.writeFile(path, content);
}

// Git-synk: kør aldrig to synk samtidig; ændringer under en kørende synk
// udløser én opfølgende. Debounce samler skriverier i ét commit.
const SYNC_DEBOUNCE_MS = 20_000;
let syncTimer: number | null = null;
let syncRunning = false;
let syncQueued = false;

function newDoc(path: string, content: string): Doc {
  return {
    path,
    content,
    baseContent: content,
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
  gitRepo: false,
  syncStatus: null,
  syncDetail: "",
  lastSyncAt: null,

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
    set({
      folder: path,
      files: listing.files,
      dirs: listing.dirs,
      changedFiles: {},
      gitRepo: false,
      syncStatus: null,
      syncDetail: "",
      lastSyncAt: null,
    });
    persistSession({ ...get() });
    // git-synk aktiveres kun, hvis mappen er et repo; første synk henter
    // ændringer fra GitHub med det samme
    try {
      const isRepo = await fsApi.gitInfo(path);
      if (get().folder !== path) return; // mappen blev skiftet imens
      set({ gitRepo: isRepo });
      if (isRepo) void get().syncNow();
    } catch {
      // uden git-info forbliver synk slået fra
    }
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

  // [[Wikilink]]: find noten på navn (uanset mappe); findes den ikke,
  // oprettes den i rodmappen — som i Obsidian
  openWikilink: async (target: string) => {
    const raw = (target.split("|")[0] ?? "").split("#")[0].trim();
    if (!raw) return;
    const { files, folder } = get();
    const found = files.find((f) => f.name.toLowerCase() === raw.toLowerCase());
    if (found) {
      await get().openFile(found.path);
      return;
    }
    if (!folder) return;
    const path = await fsApi.createFile(folder, raw);
    await get().refreshFiles();
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
      writeOwn(path, doc.content)
        .then(() => get().scheduleSync())
        .catch(() => {});
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
      await writeOwn(path, doc.content);
      const current = get().docs[path];
      if (!current) return;
      set({
        docs: {
          ...get().docs,
          [path]: {
            ...current,
            dirty: current.content !== doc.content,
            baseContent: doc.content,
            lastSavedAt: Date.now(),
          },
        },
      });
      get().scheduleSync();
    } catch {
      // beholder dirty; næste redigering forsøger igen
    }
  },

  handleFsChange: async (paths: string[]) => {
    // eksterne ændringer (Claude) skal også committes og pushes
    get().scheduleSync();
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
      if (disk === fresh.content || disk === lastWritten.get(path)) {
        // vores eget gem (eller ingen reel ændring) — også når brugeren
        // har tastet videre, inden watcher-eventet nåede frem
        if (fresh.missing) {
          set({ docs: { ...get().docs, [path]: { ...fresh, missing: false } } });
        }
        continue;
      }
      if (!fresh.dirty) {
        // ingen ugemte ændringer: opdater lydløst og vis diskret besked.
        // Banneret sættes også på faner i baggrunden, så fremhævningen
        // venter, når fanen aktiveres.
        const isActive = get().activePath === path;
        set({
          docs: {
            ...get().docs,
            [path]: {
              ...fresh,
              prevContent: fresh.content,
              content: disk,
              baseContent: disk,
              missing: false,
              claudeUpdated: !isActive,
              showExternalBanner: true,
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
        await writeOwn(path, mine);
        const current = get().docs[path];
        if (current) {
          set({
            docs: {
              ...get().docs,
              [path]: {
                ...current,
                dirty: current.content !== mine,
                baseContent: mine,
                lastSavedAt: Date.now(),
              },
            },
          });
        }
        get().scheduleSync();
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
            baseContent: doc.conflict,
            conflict: null,
            dirty: false,
            showExternalBanner: true,
            lastExternalAt: Date.now(),
          },
        },
      });
    }
  },

  // Kombinér: trevejs-fletning af mine ugemte ændringer og diskens
  // version, med seneste fælles indhold som udgangspunkt. Resultatet
  // skrives til disken, og de indkomne blokke fremhæves som eksterne.
  mergeConflict: async (path: string) => {
    const doc = get().docs[path];
    if (!doc || doc.conflict === null) return;
    const mine = doc.content;
    const merged = mergeThreeWay(doc.baseContent, mine, doc.conflict);
    set({
      docs: {
        ...get().docs,
        [path]: {
          ...doc,
          prevContent: mine,
          content: merged,
          baseContent: merged,
          conflict: null,
          dirty: false,
          showExternalBanner: true,
          lastExternalAt: Date.now(),
        },
      },
    });
    try {
      await writeOwn(path, merged);
      get().scheduleSync();
    } catch {
      // næste redigering gemmer igen
      const current = get().docs[path];
      if (current) {
        set({ docs: { ...get().docs, [path]: { ...current, dirty: true } } });
      }
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
          baseContent: restored,
          prevContent: null,
          showExternalBanner: false,
          claudeUpdated: false,
          dirty: false,
        },
      },
    });
    try {
      await writeOwn(path, restored);
      get().scheduleSync();
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
    get().scheduleSync();
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
    get().scheduleSync();
  },

  removeNote: async (path: string) => {
    await fsApi.deleteFile(path);
    if (get().tabs.includes(path)) get().closeTab(path);
    await get().refreshFiles();
    get().scheduleSync();
  },

  scheduleSync: () => {
    if (!get().gitRepo) return;
    if (syncTimer) window.clearTimeout(syncTimer);
    syncTimer = window.setTimeout(() => {
      syncTimer = null;
      void get().syncNow();
    }, SYNC_DEBOUNCE_MS);
  },

  syncNow: async () => {
    const { folder, gitRepo } = get();
    if (!folder || !gitRepo) return;
    if (syncTimer) {
      window.clearTimeout(syncTimer);
      syncTimer = null;
    }
    if (syncRunning) {
      syncQueued = true;
      return;
    }
    syncRunning = true;
    set({ syncStatus: "syncing" });
    try {
      const res = await fsApi.gitSync(folder);
      set({
        syncStatus: res.status,
        syncDetail: res.detail,
        lastSyncAt: res.status === "ok" ? Date.now() : get().lastSyncAt,
      });
    } catch (e) {
      set({ syncStatus: "error", syncDetail: String(e) });
    } finally {
      syncRunning = false;
      if (syncQueued) {
        syncQueued = false;
        get().scheduleSync();
      }
    }
  },
}));
