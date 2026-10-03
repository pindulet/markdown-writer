import { create } from "zustand";
import * as fsApi from "./backend";
import { mergeThreeWay } from "./diff";
import { cleanNoteName } from "./web/names";

export type ViewMode = "markdown" | "layout";

// skal matche AI_MODELS i src-tauri/src/main.rs; første er standard
export const AI_MODELS = [
  { id: "claude-haiku-4-5", label: "Haiku 4.5" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
] as const;
export type AiModel = (typeof AI_MODELS)[number]["id"];

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
  externalContent: string | null; // indholdet lige efter den eksterne opdatering
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
  zoom: number; // skalering af editortekst, 1 = normal
  aiEnabled: boolean; // automatiske AI-forslag mens man skriver
  aiAvailable: boolean; // der findes en API-nøgle
  aiModel: AiModel; // hvilken model der laver forslagene
  aiKeyDialogOpen: boolean;
  aiLastError: string | null; // seneste fejl fra forslags-kaldet, vises i statusbaren
  syncProgress: { done: number; total: number } | null; // fx telefonens første hentning
  editing: boolean; // mobil: noten er i redigeringstilstand (ellers læsetilstand)
  notice: string | null; // kort besked til brugeren (vises som toast), rydder sig selv

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
  setSidebarVisible: (visible: boolean) => void;
  setEditing: (editing: boolean) => void;
  // sand = intet er ugemt bagefter (ingen doc er beskidt eller i konflikt)
  flushAll: () => Promise<boolean>;
  setNewNoteOpen: (open: boolean, dir?: string) => void;
  setNewFolderParent: (parent: string | null) => void;
  setShortcutsOpen: (open: boolean) => void;
  setZoom: (zoom: number) => void;
  showNotice: (text: string) => void;
  toggleAi: () => void;
  setAiError: (err: string | null) => void;
  setAiModel: (model: AiModel) => void;
  setAiKeyDialogOpen: (open: boolean) => void;
  saveAiKey: (key: string) => Promise<void>;
  newNote: (name: string, relDir: string) => Promise<void>;
  newFolder: (name: string) => Promise<void>;
  renameNote: (path: string, newName: string) => Promise<void>;
  removeNote: (path: string) => Promise<void>;
  scheduleSync: () => void;
  syncNow: () => Promise<void>;
}

const saveTimers = new Map<string, number>();
let refreshTimer: number | null = null;
let noticeTimer: number | null = null;
const NOTICE_MS = 4_000;

// Telefonens CSS har et gulv på 16 px (ellers zoomer iOS), så mindre end 100 %
// gør kun overskrifterne mindre end brødteksten
export function minZoom(): number {
  return fsApi.platform === "web" ? 1 : 0.7;
}
const MAX_ZOOM = 1.6;

// Mål i et [[wikilink]], der er en anden filtype end en note (bilag.pdf, foto.png)
function isAttachmentName(name: string): boolean {
  const base = name.slice(name.lastIndexOf("/") + 1);
  return /\.[a-z][a-z0-9]{0,4}$/i.test(base) && !/\.md$/i.test(base);
}

// Navne sammenlignes uden hensyn til NFC/NFD og store/små bogstaver
const nameKey = (s: string) => s.normalize("NFC").toLowerCase();

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
// udløser én opfølgende. Debounce samler skriverier i ét commit. Telefonen
// lukkes tit hurtigt efter en redigering, så dér synkes der hurtigere.
const SYNC_DEBOUNCE_MS = fsApi.platform === "web" ? 15_000 : 20_000;
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
    externalContent: null,
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
  zoom: 1,
  aiEnabled: true,
  aiAvailable: false,
  aiModel: AI_MODELS[0].id,
  aiKeyDialogOpen: false,
  aiLastError: null,
  syncProgress: null,
  editing: false,
  notice: null,

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
      const z = Number(localStorage.getItem("mw.zoom"));
      if (z >= 0.7 && z <= MAX_ZOOM) get().setZoom(z); // setZoom løfter til gulvet på web
      if (localStorage.getItem("mw.ai") === "0") set({ aiEnabled: false });
      const m = AI_MODELS.find((x) => x.id === localStorage.getItem("mw.aiModel"));
      if (m) set({ aiModel: m.id });
    } catch {
      // ignorer korrupt session
    }
    set({ view });
    fsApi.onSyncProgress((progress) => set({ syncProgress: progress }));
    // uden nøgle vises "nøgle mangler" i statusbaren; klik åbner dialogen
    void fsApi
      .aiKeyPresent()
      .then((present) => set({ aiAvailable: present }))
      .catch(() => {});
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
  // oprettes den i rodmappen — som i Obsidian. Bilag oprettes aldrig som note.
  openWikilink: async (target: string) => {
    // i tabeller escapes aliasets streg ([[Note\|alias]]); en løs backslash
    // kan også blive hængende sidst i målet
    const raw = (target.replace(/\\\|/g, "|").split("|")[0] ?? "")
      .split("#")[0]
      .replace(/\\+$/, "")
      .trim();
    const name = raw.replace(/\.md$/i, "").trim();
    if (!name) return;
    const { files, folder } = get();
    // på telefonen renses nye notenavne (fx ":" → "-"), så [[Møde: referat]]
    // skal også finde noten "Møde- referat", ellers oprettes den igen og igen
    const want = nameKey(name);
    const cleaned = fsApi.platform === "web" ? nameKey(cleanNoteName(name)) : want;
    const byPath = want.includes("/"); // [[Mappe/Note]]
    const found = files.find((f) => {
      if (byPath) {
        const rel = nameKey(f.rel_dir ? `${f.rel_dir}/${f.name}` : f.name);
        return rel === want || rel.endsWith(`/${want}`);
      }
      const key = nameKey(f.name);
      return key === want || key === cleaned;
    });
    if (found) {
      await get().openFile(found.path);
      return;
    }
    if (isAttachmentName(name)) {
      get().showNotice(
        fsApi.platform === "web" ? "Bilag kan kun åbnes på computeren" : "Bilaget findes ikke som note"
      );
      return;
    }
    if (!folder) return;
    const path = await fsApi.createFile(folder, name);
    await get().refreshFiles();
    await get().openFile(path);
  },

  activate: (path: string) => {
    const { docs, changedFiles, activePath } = get();
    const doc = docs[path];
    const nextChanged = { ...changedFiles };
    delete nextChanged[path];
    set({
      activePath: path,
      // mobil: en anden note åbnes altid i læsetilstand
      editing: path === activePath ? get().editing : false,
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
              externalContent: disk,
              content: disk,
              baseContent: disk,
              missing: false,
              claudeUpdated: !isActive,
              showExternalBanner: true,
              lastExternalAt: Date.now(),
            },
          },
        });
      } else if (fsApi.platform === "web") {
        // telefonen: flet straks. Et konfliktbanner ville stoppe al gemning,
        // og iOS lukker appen tit i baggrunden — så var det skrevne tabt.
        // Fortryd giver brugerens egen version tilbage.
        const merged = mergeThreeWay(fresh.baseContent, fresh.content, disk);
        const isActive = get().activePath === path;
        set({
          docs: {
            ...get().docs,
            [path]: {
              ...fresh,
              prevContent: fresh.content,
              externalContent: merged,
              content: merged,
              baseContent: merged,
              dirty: false,
              missing: false,
              claudeUpdated: !isActive,
              showExternalBanner: true,
              lastExternalAt: Date.now(),
            },
          },
        });
        try {
          await writeOwn(path, merged);
          get().scheduleSync();
        } catch {
          // næste gem prøver igen
          const current = get().docs[path];
          if (current) set({ docs: { ...get().docs, [path]: { ...current, dirty: true } } });
        }
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
            externalContent: doc.conflict,
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
          externalContent: merged,
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
    // Har brugeren skrevet videre efter opdateringen, fjernes kun den
    // eksterne ændring: trevejs-fletning med opdateringen som udgangspunkt,
    // så det nyskrevne bliver stående
    const restored =
      doc.externalContent !== null && doc.content !== doc.externalContent
        ? mergeThreeWay(doc.externalContent, doc.content, doc.prevContent)
        : doc.prevContent;
    const timer = saveTimers.get(path);
    if (timer) {
      window.clearTimeout(timer);
      saveTimers.delete(path);
    }
    set({
      docs: {
        ...get().docs,
        [path]: {
          ...doc,
          content: restored,
          baseContent: restored,
          prevContent: null,
          externalContent: null,
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

  setSidebarVisible: (visible: boolean) => set({ sidebarVisible: visible }),

  setEditing: (editing: boolean) => set({ editing }),

  // Gem alle ugemte ændringer med det samme (fx når telefonen lægger appen
  // i baggrunden, eller før appen genindlæses til en ny version)
  flushAll: async () => {
    for (const [path, timer] of saveTimers) {
      window.clearTimeout(timer);
      saveTimers.delete(path);
    }
    const dirty = Object.values(get().docs).filter((d) => d.dirty);
    await Promise.all(dirty.map((d) => get().saveNow(d.path)));
    // saveNow sluger fejl og springer konflikter over: se efter, hvad der stadig er ugemt
    return Object.values(get().docs).every((d) => !d.dirty && d.conflict === null);
  },

  setNewNoteOpen: (open: boolean, dir?: string) =>
    set({ newNoteOpen: open, newNoteDir: dir ?? "" }),

  setNewFolderParent: (parent: string | null) => set({ newFolderParent: parent }),

  setShortcutsOpen: (open: boolean) => set({ shortcutsOpen: open }),

  setZoom: (zoom: number) => {
    // afrundes til ét decimal, så gentagne tryk ikke driver i flydende tal
    const clamped = Math.round(Math.min(MAX_ZOOM, Math.max(minZoom(), zoom)) * 10) / 10;
    set({ zoom: clamped });
    document.documentElement.style.setProperty("--editor-zoom", String(clamped));
    try {
      localStorage.setItem("mw.zoom", String(clamped));
    } catch {
      // ikke kritisk
    }
  },

  showNotice: (text: string) => {
    if (noticeTimer) window.clearTimeout(noticeTimer);
    set({ notice: text });
    noticeTimer = window.setTimeout(() => {
      noticeTimer = null;
      set({ notice: null });
    }, NOTICE_MS);
  },

  toggleAi: () => {
    // AI-forslag kører via Rust-siden og findes kun på computeren
    if (fsApi.platform === "web") return;
    if (!get().aiAvailable) {
      set({ aiKeyDialogOpen: true });
      return;
    }
    const enabled = !get().aiEnabled;
    set({ aiEnabled: enabled, aiLastError: null });
    try {
      localStorage.setItem("mw.ai", enabled ? "1" : "0");
    } catch {
      // ikke kritisk
    }
  },

  setAiError: (err: string | null) => {
    if (get().aiLastError !== err) set({ aiLastError: err });
  },

  setAiModel: (model: AiModel) => {
    set({ aiModel: model });
    try {
      localStorage.setItem("mw.aiModel", model);
    } catch {
      // ikke kritisk
    }
  },

  setAiKeyDialogOpen: (open: boolean) => set({ aiKeyDialogOpen: open }),

  saveAiKey: async (key: string) => {
    await fsApi.aiSetKey(key);
    set({ aiAvailable: true, aiEnabled: true, aiKeyDialogOpen: false, aiLastError: null });
    try {
      localStorage.setItem("mw.ai", "1");
    } catch {
      // ikke kritisk
    }
  },

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
    if (doc) nextDocs[newPath] = { ...doc, path: newPath, missing: false };
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
    // luk fanen uden at gemme ugemte tastetryk — ellers genskaber gemningen
    // den note, der netop er slettet
    const timer = saveTimers.get(path);
    if (timer) {
      window.clearTimeout(timer);
      saveTimers.delete(path);
    }
    const doc = get().docs[path];
    if (doc?.dirty) {
      set({ docs: { ...get().docs, [path]: { ...doc, dirty: false } } });
    }
    if (get().tabs.includes(path)) get().closeTab(path);
    await fsApi.deleteFile(path);
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
        // telefonen: straks — en timer står stille, når iOS har lagt appen væk
        if (fsApi.platform === "web") void get().syncNow();
        else get().scheduleSync();
      }
    }
  },
}));
