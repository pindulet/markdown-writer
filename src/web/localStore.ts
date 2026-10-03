// Telefonens "disk": noterne i IndexedDB (eller i hukommelsen i tests).
// update() er atomisk — læs og skriv sker i samme transaktion — så synk og
// UI aldrig overskriver hinandens ændringer.
import type { FileRecord, LocalStore, SyncMeta } from "./types";

export const DEFAULT_DB_NAME = "markdown-writer";

// Format-version på posterne. Hæves den, skal gamle poster migreres —
// aldrig smides væk, for de kan rumme ændringer, der ikke er på GitHub endnu.
const FORMAT = 1;
const DB_VERSION = 1;
const FILES = "files";
const META = "meta";
const META_KEY = "sync";

type StoredFile = FileRecord & { v: number };
type StoredMeta = SyncMeta & { v: number };

const emptyMeta = (): SyncMeta => ({ headCommit: null, headTree: null, headEtag: null });

// sent er valgfrit og gemmes kun, når det er sat (ældre poster har det ikke)
function fromStored(s: StoredFile): FileRecord {
  return {
    path: s.path,
    sha: s.sha ?? null,
    base: s.base ?? null,
    content: s.content ?? null,
    deleted: !!s.deleted,
    mtime: s.mtime ?? 0,
    ...(typeof s.sent === "string" ? { sent: s.sent } : {}),
  };
}

function toStored(r: FileRecord): StoredFile {
  return {
    v: FORMAT,
    path: r.path,
    sha: r.sha,
    base: r.base,
    content: r.content,
    deleted: r.deleted,
    mtime: r.mtime,
    ...(typeof r.sent === "string" ? { sent: r.sent } : {}),
  };
}

function metaFromStored(s: Partial<StoredMeta> | undefined): SyncMeta {
  if (!s) return emptyMeta();
  return { headCommit: s.headCommit ?? null, headTree: s.headTree ?? null, headEtag: s.headEtag ?? null };
}

// Fejl, der betyder "forbindelsen til databasen er tabt" (kendt iOS-fejl) — åbn igen
function connectionLost(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  return name === "UnknownError" || name === "InvalidStateError";
}

// fn kastede inde i update — må ikke forveksles med en databasefejl
class UpdateFnError {
  constructor(readonly cause: unknown) {}
}

interface TxCtx<T> {
  tx: IDBTransaction;
  set: (v: T) => void;
  fail: (e: unknown) => void; // afbryd transaktionen og afvis med e
}

export function openIdbStore(dbName: string = DEFAULT_DB_NAME): LocalStore {
  let dbp: Promise<IDBDatabase> | null = null;

  function open(): Promise<IDBDatabase> {
    if (dbp) return dbp;
    const p = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("Telefonens lager (IndexedDB) er ikke tilgængeligt"));
        return;
      }
      const req = indexedDB.open(dbName, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES, { keyPath: "path" });
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      };
      req.onsuccess = () => {
        const db = req.result;
        const forget = () => {
          if (dbp === p) dbp = null;
        };
        // en anden fane/version vil opgradere eller slette: slip databasen
        db.onversionchange = () => {
          db.close();
          forget();
        };
        db.onclose = forget; // lukket udefra (fx iOS' "Connection … lost")
        resolve(db);
      };
      req.onerror = () => reject(req.error ?? new Error("Kunne ikke åbne telefonens lager"));
    });
    dbp = p;
    p.catch(() => {
      if (dbp === p) dbp = null; // næste kald prøver forfra
    });
    return p;
  }

  function reset(db: IDBDatabase | null) {
    try {
      db?.close();
    } catch {
      // allerede lukket
    }
    dbp = null;
  }

  // Én transaktion. work kører synkront inde i den og sætter resultatet med
  // set; løftet indfries først, når transaktionen er gennemført (complete).
  async function transact<T>(
    stores: string[],
    mode: IDBTransactionMode,
    work: (tx: TxCtx<T>) => void
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let db: IDBDatabase | null = null;
      try {
        db = await open();
        const conn = db;
        return await new Promise<T>((resolve, reject) => {
          const tx = conn.transaction(stores, mode);
          let result: T;
          let fnError: UpdateFnError | null = null;
          tx.oncomplete = () => resolve(result);
          tx.onabort = () =>
            reject(fnError ?? tx.error ?? new DOMException("Transaktionen blev afbrudt", "AbortError"));
          const fail = (e: unknown) => {
            fnError = new UpdateFnError(e);
            try {
              tx.abort();
            } catch {
              // allerede afsluttet
            }
          };
          try {
            work({ tx, set: (v) => (result = v), fail });
          } catch (e) {
            // databasefejl (fx tabt forbindelse) — ikke fn's skyld, så genforsøg er muligt
            try {
              tx.abort();
            } catch {
              // allerede afsluttet
            }
            reject(e);
          }
        });
      } catch (e) {
        if (e instanceof UpdateFnError) throw e.cause;
        if (attempt === 0 && connectionLost(e)) {
          reset(db);
          continue;
        }
        throw e;
      }
    }
  }

  return {
    getMeta: () =>
      transact<SyncMeta>([META], "readonly", ({ tx, set }) => {
        const req = tx.objectStore(META).get(META_KEY);
        req.onsuccess = () => set(metaFromStored(req.result as StoredMeta | undefined));
      }),

    setMeta: (meta) =>
      transact<void>([META], "readwrite", ({ tx, set }) => {
        const stored: StoredMeta = {
          v: FORMAT,
          headCommit: meta.headCommit,
          headTree: meta.headTree,
          headEtag: meta.headEtag,
        };
        tx.objectStore(META).put(stored, META_KEY);
        set(undefined);
      }),

    get: (path) =>
      transact<FileRecord | undefined>([FILES], "readonly", ({ tx, set }) => {
        const req = tx.objectStore(FILES).get(path);
        req.onsuccess = () => set(req.result ? fromStored(req.result as StoredFile) : undefined);
      }),

    all: () =>
      transact<FileRecord[]>([FILES], "readonly", ({ tx, set }) => {
        const req = tx.objectStore(FILES).getAll();
        req.onsuccess = () => set((req.result as StoredFile[]).map(fromStored));
      }),

    update: (path, fn) =>
      transact<FileRecord | undefined>([FILES], "readwrite", ({ tx, set, fail }) => {
        const os = tx.objectStore(FILES);
        const req = os.get(path);
        req.onsuccess = () => {
          const cur = req.result ? fromStored(req.result as StoredFile) : undefined;
          let next: FileRecord | null | undefined;
          try {
            next = fn(cur);
          } catch (e) {
            fail(e);
            return;
          }
          if (next === undefined) {
            set(cur);
          } else if (next === null) {
            if (cur) os.delete(path);
            set(undefined);
          } else {
            const rec = { ...next, path }; // nøglen er altid stien, der blev bedt om
            os.put(toStored(rec));
            set(fromStored(toStored(rec)));
          }
        };
      }),

    clear: () =>
      transact<void>([FILES, META], "readwrite", ({ tx, set }) => {
        tx.objectStore(FILES).clear();
        tx.objectStore(META).clear();
        set(undefined);
      }),
  };
}

// Sletter hele databasen (fx "Glem telefonens data"). Åbne forbindelser i
// denne og andre faner lukker sig selv ved versionchange.
export function deleteIdbDatabase(dbName: string = DEFAULT_DB_NAME): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      resolve();
      return;
    }
    const req = indexedDB.deleteDatabase(dbName);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("Kunne ikke slette telefonens lager"));
  });
}

// Samme kontrakt i hukommelsen — til tests
export function createMemoryStore(): LocalStore {
  const files = new Map<string, FileRecord>();
  let meta = emptyMeta();
  const copy = (r: FileRecord | undefined) => (r ? { ...r } : undefined);
  return {
    getMeta: async () => ({ ...meta }),
    setMeta: async (m) => {
      meta = { headCommit: m.headCommit, headTree: m.headTree, headEtag: m.headEtag };
    },
    get: async (path) => copy(files.get(path)),
    all: async () => [...files.values()].map((r) => ({ ...r })),
    update: async (path, fn) => {
      const cur = copy(files.get(path));
      const next = fn(cur);
      if (next === undefined) return cur;
      if (next === null) {
        files.delete(path);
        return undefined;
      }
      const rec = { ...next, path };
      files.set(path, rec);
      return { ...rec };
    },
    clear: async () => {
      files.clear();
      meta = emptyMeta();
    },
  };
}
