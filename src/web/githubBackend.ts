// Web-/mobiludgavens "filsystem": noterne bor i telefonens IndexedDB og
// synkes med GitHub (syncEngine.ts). Stierne ser ud som på computeren
// ("/notes/Mappe/Note.md"), så store.ts og komponenterne virker uændret, og
// ændringer fra computeren kommer ind som fs-change efter en synk.
import type { Backend, FileEntry, GitSyncResult } from "../backend";
import { mergeThreeWay } from "../diff";
import { clearConfig, loadConfig as loadSavedConfig, vaultRoot } from "./config";
import { createGitHubApi } from "./github";
import { deleteIdbDatabase, openIdbStore } from "./localStore";
import { cleanName, cleanNoteName, uniqueName } from "./names";
import { createSyncEngine, isNoteFile, pathKey, type SyncEngine } from "./syncEngine";
import {
  GitHubError,
  isDirty,
  type FileRecord,
  type GitHubApi,
  type GitHubConfig,
  type LocalStore,
} from "./types";

export interface GitHubBackendDeps {
  store?: LocalStore;
  createApi?: (cfg: GitHubConfig) => GitHubApi;
  loadConfig?: () => GitHubConfig | null;
}

type Progress = { done: number; total: number } | null;

const DIRS_KEY = "mw.web.dirs"; // tomme mapper oprettet på telefonen (git kender ikke tomme mapper)
const BIG_PULL = 50; // vis også fremdrift, når så mange noter hentes på én gang
const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const AI_DESKTOP_ONLY = "AI-forslag findes kun på computeren";
const NAME_TAKEN = "Der findes allerede en note med det navn";
const NOT_FOUND = "Filen findes ikke";

let sharedStore: LocalStore | null = null;
let forgotten = false; // resetWebData er kaldt; siden genindlæses om lidt

function defaultStore(): LocalStore {
  return (sharedStore ??= openIdbStore());
}

// Efter "Glem telefonens data" må intet genskabe databasen — heller ikke en
// synk, der allerede er i gang
function guarded(store: LocalStore): LocalStore {
  const check = () => {
    if (forgotten) throw new Error("Telefonens data er glemt — åbn appen igen");
  };
  return {
    getMeta: async () => (check(), store.getMeta()),
    setMeta: async (meta) => (check(), store.setMeta(meta)),
    get: async (path) => (check(), store.get(path)),
    all: async () => (check(), store.all()),
    update: async (path, fn) => (check(), store.update(path, fn)),
    clear: async () => (check(), store.clear()),
  };
}

function sameConnection(a: GitHubConfig, b: GitHubConfig): boolean {
  return a.owner === b.owner && a.repo === b.repo && a.branch === b.branch && a.token === b.token;
}

const joinRel = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const parentOf = (rel: string) => rel.slice(0, Math.max(0, rel.lastIndexOf("/")));
const baseName = (rel: string) => rel.slice(rel.lastIndexOf("/") + 1);

// "A/B" → ["A", "A/B"]
function ancestors(dir: string): string[] {
  if (!dir) return [];
  const parts = dir.split("/");
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

function loadLocalDirs(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(DIRS_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((d): d is string => typeof d === "string" && d !== "") : [];
  } catch {
    return [];
  }
}

function saveLocalDirs(dirs: string[]): void {
  try {
    if (dirs.length) localStorage.setItem(DIRS_KEY, JSON.stringify(dirs));
    else localStorage.removeItem(DIRS_KEY);
  } catch {
    // uden lager forsvinder den tomme mappe bare igen
  }
}

// Alle mapper, noterne ligger i, plus telefonens tomme mapper (pathKey → sti).
// En tom mappe glemmes, så snart der ligger en note i den.
function collectDirs(records: FileRecord[]): Map<string, string> {
  const dirs = new Map<string, string>();
  const add = (d: string) => {
    for (const a of ancestors(d)) if (!dirs.has(pathKey(a))) dirs.set(pathKey(a), a);
  };
  for (const r of records) if (!r.deleted && isNoteFile(r.path)) add(parentOf(r.path));
  const local = loadLocalDirs();
  const empty = local.filter((d) => !dirs.has(pathKey(d)));
  if (empty.length !== local.length) saveLocalDirs(empty);
  empty.forEach(add);
  return dirs;
}

function emit<T>(subs: Set<(value: T) => void>, value: T): void {
  for (const cb of [...subs]) {
    try {
      cb(value);
    } catch {
      // en fejl i UI'et må ikke vælte gem eller synk
    }
  }
}

export function createGitHubBackend(deps: GitHubBackendDeps = {}): Backend {
  const store = guarded(deps.store ?? defaultStore());
  const readConfig = deps.loadConfig ?? loadSavedConfig;
  const createApi = deps.createApi ?? ((cfg: GitHubConfig) => createGitHubApi(cfg));

  const fsSubs = new Set<(paths: string[]) => void>();
  const progressSubs = new Set<(progress: Progress) => void>();

  // Det, UI'et senest har læst eller skrevet pr. note (repo-relativ sti).
  // Har en synk ændret noten siden, er en skrivning forældet og flettes ind.
  const lastSeen = new Map<string, string>();

  let progressWanted = false;
  let progressShown = false;
  const onProgress = (done: number, total: number) => {
    if (!progressWanted && total < BIG_PULL) return;
    progressShown = true;
    emit(progressSubs, { done, total });
  };

  interface Connection {
    cfg: GitHubConfig;
    root: string;
    api: GitHubApi;
    engine: SyncEngine;
    idle: Promise<unknown>; // seneste synk
  }
  let conn: Connection | null = null;

  // Forbindelsen læses ved hvert kald (opsætningen gemmer den, efter modulet
  // er indlæst). Ny nøgle eller nyt repo giver ny klient og ny motor.
  function connection(): Connection {
    const cfg = readConfig();
    if (!cfg) throw new Error("Telefonen er ikke forbundet med GitHub");
    if (!conn || !sameConnection(conn.cfg, cfg)) {
      const api = createApi(cfg);
      conn = {
        cfg,
        root: vaultRoot(cfg),
        api,
        engine: createSyncEngine(store, api, { onProgress }),
        idle: conn?.idle ?? Promise.resolve(), // en synk med den gamle nøgle skal være færdig først
      };
    }
    return conn;
  }

  function relOf(root: string, abs: string): string {
    if (abs === root) return "";
    if (abs.startsWith(`${root}/`)) return abs.slice(root.length + 1);
    throw new Error("Stien hører ikke til noterne");
  }

  function fileRel(root: string, abs: string): string {
    const rel = relOf(root, abs);
    if (!rel) throw new Error(NOT_FOUND);
    return rel;
  }

  // Noten på stien — eller, findes den ikke, samme note stavet anderledes
  // (store/små bogstaver, NFC/NFD), som computerens filsystem også ville ramme
  async function locate(rel: string): Promise<FileRecord | undefined> {
    const exact = await store.get(rel);
    if (exact && !exact.deleted) return exact;
    const key = pathKey(rel);
    const twin = (await store.all()).find((r) => !r.deleted && r.path !== rel && pathKey(r.path) === key);
    return twin ?? exact;
  }

  // Teksten, også hvis den ikke er hentet endnu (content null: hentes via sha)
  async function textOf(api: GitHubApi, rec: FileRecord): Promise<string> {
    if (rec.content !== null) return rec.content;
    const sha = rec.sha;
    if (sha === null) return "";
    let text: string | undefined;
    try {
      text = (await api.getBlobTexts([sha])).get(sha);
    } catch (e) {
      if (e instanceof GitHubError && e.kind === "offline") {
        throw new Error("Noten er ikke hentet til telefonen endnu, og der er ingen forbindelse");
      }
      throw e;
    }
    if (text === undefined) throw new Error("Noten kunne ikke hentes fra GitHub");
    const fetched = text;
    // en samtidig synk eller skrivning vinder
    const after = await store.update(rec.path, (cur) =>
      cur && cur.content === null && cur.sha === sha ? { ...cur, base: fetched, content: fetched } : undefined
    );
    if (!after || after.deleted) throw new Error(NOT_FOUND);
    return after.content ?? fetched;
  }

  async function noteKeys(): Promise<Set<string>> {
    return new Set((await store.all()).filter((r) => !r.deleted).map((r) => pathKey(r.path)));
  }

  return {
    listFolder: async (path) => {
      const { root } = connection();
      const base = relOf(root, path);
      const prefix = base ? `${base}/` : "";
      const records = await store.all();
      const files: FileEntry[] = [];
      for (const r of records) {
        if (r.deleted || !isNoteFile(r.path) || !r.path.startsWith(prefix)) continue;
        files.push({
          name: baseName(r.path).replace(/\.md$/i, ""),
          path: `${root}/${r.path}`,
          rel_dir: parentOf(r.path.slice(prefix.length)),
          modified_ms: r.mtime,
        });
      }
      const dirs = [...collectDirs(records).values()]
        .filter((d) => d.startsWith(prefix) && d.length > prefix.length)
        .map((d) => d.slice(prefix.length))
        .sort();
      return { files, dirs };
    },

    readFile: async (path) => {
      const c = connection();
      const rel = fileRel(c.root, path);
      const rec = await locate(rel);
      if (!rec || rec.deleted) throw new Error(NOT_FOUND);
      const text = await textOf(c.api, rec);
      lastSeen.set(rel, text);
      return text;
    },

    writeFile: async (path, content) => {
      const { root } = connection();
      const rel = fileRel(root, path);
      if (!isNoteFile(rel)) throw new Error("Kun noter (.md) kan gemmes på telefonen");
      const found = await locate(rel);
      const target = found && !found.deleted ? found.path : rel;
      const seen = lastSeen.get(rel);
      const t = Date.now();
      let saved = content;
      await store.update(target, (cur) => {
        saved = content;
        if (!cur) return { path: target, sha: null, base: null, content, deleted: false, mtime: t };
        // en synk har ændret noten, siden UI'et sidst så den: flet i stedet for at overskrive
        const theirs = cur.deleted ? null : cur.content;
        if (seen !== undefined && theirs !== null && theirs !== seen && theirs !== content) {
          saved = mergeThreeWay(seen, content, theirs);
        }
        return { ...cur, content: saved, deleted: false, mtime: t };
      });
      // UI'ets tekst bygger stadig på det, det selv skrev, indtil det har
      // genindlæst den flettede — så næste gem flettes også, hvis det kommer først
      lastSeen.set(rel, content);
      if (saved !== content) {
        // først når store'n har registreret sit eget gem, så det ligner en
        // almindelig ekstern ændring (lydløs opdatering + fremhævning)
        setTimeout(() => emit(fsSubs, [path]), 0);
      }
    },

    createFile: async (dir, name) => {
      const { root } = connection();
      const dirRel = relOf(root, dir);
      const wanted = cleanNoteName(name);
      const t = Date.now();
      for (let attempt = 0; attempt < 3; attempt++) {
        const taken = await noteKeys();
        const fileName = uniqueName(wanted, (n) => taken.has(pathKey(joinRel(dirRel, `${n}.md`))));
        const rel = joinRel(dirRel, `${fileName}.md`);
        if (!isNoteFile(rel)) throw new Error("Noten kan ikke oprettes her");
        let created = false;
        await store.update(rel, (cur) => {
          created = !cur || cur.deleted;
          if (!created) return undefined; // oprettet imens: prøv næste navn
          return cur
            ? { ...cur, content: "", deleted: false, mtime: t }
            : { path: rel, sha: null, base: null, content: "", deleted: false, mtime: t };
        });
        if (created) {
          lastSeen.set(rel, "");
          return `${root}/${rel}`;
        }
      }
      throw new Error("Noten kunne ikke oprettes");
    },

    // Kun på telefonen, indtil der gemmes en note i mappen
    createFolder: async (dir, name) => {
      const { root } = connection();
      const parentRel = relOf(root, dir);
      const dirs = collectDirs(await store.all());
      const folder = uniqueName(cleanName(name), (n) => dirs.has(pathKey(joinRel(parentRel, n))));
      const rel = joinRel(parentRel, folder);
      saveLocalDirs([...loadLocalDirs(), rel]);
      return `${root}/${rel}`;
    },

    // Vaultens billeder holdes ude af git, så de kan ikke komme med herfra
    saveImage: async () => {
      throw new Error("Billeder kan kun indsættes på computeren");
    },

    renameFile: async (path, newName) => {
      const c = connection();
      const rel = fileRel(c.root, path);
      const rec = await locate(rel);
      if (!rec || rec.deleted) throw new Error(NOT_FOUND);
      const from = rec.path;
      const to = joinRel(parentOf(from), `${cleanNoteName(newName)}.md`);
      // samme navn (evt. kun en anden Unicode-form): intet at gøre
      if (to.normalize("NFC") === from.normalize("NFC")) return `${c.root}/${from}`;
      // også når kun store/små bogstaver er ændret: på computeren er det samme fil
      if ((await noteKeys()).has(pathKey(to))) throw new Error(NAME_TAKEN);
      const content = await textOf(c.api, rec);
      const t = Date.now();
      let clash = false;
      await store.update(to, (cur) => {
        clash = !!cur && !cur.deleted;
        if (clash) return undefined;
        return cur
          ? { ...cur, content, deleted: false, mtime: t }
          : { path: to, sha: null, base: null, content, deleted: false, mtime: t };
      });
      if (clash) throw new Error(NAME_TAKEN);
      // den nye post er skrevet, før den gamle forsvinder: går noget galt
      // midt i, findes noten to gange — aldrig nul gange
      let latest = null as string | null;
      await store.update(from, (cur) => {
        latest = cur && !cur.deleted ? cur.content : null;
        if (!cur) return undefined;
        return cur.sha !== null ? { ...cur, deleted: true, mtime: t } : null;
      });
      const newer = latest;
      if (newer !== null && newer !== content) {
        // en synk nåede at ændre noten imens
        await store.update(to, (cur) =>
          cur && !cur.deleted && cur.content === content ? { ...cur, content: newer } : undefined
        );
      }
      const seen = lastSeen.get(rel);
      lastSeen.delete(rel);
      lastSeen.set(to, seen ?? newer ?? content);
      return `${c.root}/${to}`;
    },

    // Slettet her = slettet på GitHub ved næste synk (kan gendannes fra historikken)
    deleteFile: async (path) => {
      const { root } = connection();
      const rel = fileRel(root, path);
      const rec = await locate(rel);
      lastSeen.delete(rel);
      if (!rec || rec.deleted) return;
      const t = Date.now();
      await store.update(rec.path, (cur) => {
        if (!cur) return undefined;
        return cur.sha !== null ? { ...cur, deleted: true, mtime: t } : null;
      });
      // mappen bliver stående, som på computeren
      const dir = parentOf(rec.path);
      const local = loadLocalDirs();
      if (dir && !local.some((d) => pathKey(d) === pathKey(dir))) saveLocalDirs([...local, dir]);
    },

    watchFolder: async () => {},

    gitInfo: async () => readConfig() !== null,

    gitSync: async (): Promise<GitSyncResult> => {
      let c: Connection;
      try {
        c = connection();
      } catch {
        return { status: "error", committed: 0, detail: "Telefonen er ikke forbundet med GitHub." };
      }
      await c.idle;
      try {
        progressWanted = (await store.getMeta()).headCommit === null; // første hentning
      } catch {
        progressWanted = false;
      }
      const run = c.engine.sync();
      c.idle = run.catch(() => undefined);
      const out = await run.finally(() => {
        progressWanted = false;
        if (progressShown) {
          progressShown = false;
          emit(progressSubs, null);
        }
      });
      // første hentning: genindlæs listen uden at give alle noter en prik
      if (out.initial) emit(fsSubs, []);
      else if (out.changedPaths.length) emit(fsSubs, out.changedPaths.map((p) => `${c.root}/${p}`));
      return { status: out.status, committed: out.committed, detail: out.detail };
    },

    pickFolder: async () => null,

    // kun almindelige links — aldrig javascript:, data: o.l.
    openUrl: async (url) => {
      let protocol: string;
      try {
        protocol = new URL(url).protocol;
      } catch {
        return;
      }
      if (SAFE_PROTOCOLS.has(protocol)) window.open(url, "_blank", "noopener");
    },

    onFsChange: (cb) => {
      fsSubs.add(cb);
      return () => fsSubs.delete(cb);
    },

    onOpenFile: () => () => {},

    onSyncProgress: (cb) => {
      progressSubs.add(cb);
      return () => progressSubs.delete(cb);
    },

    frontendReady: async () => [],

    aiKeyPresent: async () => false,

    aiSetKey: async () => {
      throw new Error(AI_DESKTOP_ONLY);
    },

    suggestCompletion: async () => {
      throw new Error(AI_DESKTOP_ONLY);
    },
  };
}

// Antal noter med ændringer, der endnu ikke er sendt til GitHub
export async function pendingChangesCount(store: LocalStore = defaultStore()): Promise<number> {
  if (forgotten) return 0;
  return (await store.all()).filter((r) => isNoteFile(r.path) && isDirty(r)).length;
}

// Glemmer forbindelsen og telefonens lokale kopi af noterne. Indstillingerne
// genindlæser siden bagefter.
export async function resetWebData(): Promise<void> {
  forgotten = true;
  try {
    await deleteIdbDatabase();
  } catch (e) {
    forgotten = false;
    throw e;
  }
  sharedStore = null;
  clearConfig();
  for (const name of ["localStorage", "sessionStorage"] as const) {
    try {
      const storage = globalThis[name];
      const keys: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key?.startsWith("mw.")) keys.push(key);
      }
      keys.forEach((key) => storage.removeItem(key));
    } catch {
      // ikke kritisk
    }
  }
}
