import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeRemote } from "./fakeRemote";
import { createMemoryStore, deleteIdbDatabase, openIdbStore } from "./localStore";
import { createSyncEngine } from "./syncEngine";
import type { FileRecord, LocalStore } from "./types";

let dbCounter = 0;
const freshName = () => `mw-test-${++dbCounter}`;

const rec = (path: string, content: string, extra: Partial<FileRecord> = {}): FileRecord => ({
  path,
  sha: null,
  base: null,
  content,
  deleted: false,
  mtime: 1,
  ...extra,
});

// Åbner databasen rå (uden LocalStore) for at se, hvad der faktisk er gemt
function rawOpen(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function rawGet(db: IDBDatabase, store: string, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, "readonly").objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Fanger den IDBDatabase, LocalStore'en åbner, så testen kan "miste" forbindelsen
function captureDb(): () => IDBDatabase {
  const spy = vi.spyOn(indexedDB, "open");
  return () => {
    const req = spy.mock.results.at(-1)?.value as IDBOpenDBRequest;
    return req.result;
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

const stores: [string, () => LocalStore][] = [
  ["IndexedDB", () => openIdbStore(freshName())],
  ["hukommelse", () => createMemoryStore()],
];

describe.each(stores)("LocalStore-kontrakten (%s)", (_name, make) => {
  it("tom: standard-meta og ingen poster", async () => {
    const store = make();
    expect(await store.getMeta()).toEqual({ headCommit: null, headTree: null, headEtag: null });
    expect(await store.all()).toEqual([]);
    expect(await store.get("x.md")).toBeUndefined();
  });

  it("meta gemmes og læses", async () => {
    const store = make();
    await store.setMeta({ headCommit: "c1", headTree: "t1", headEtag: '"e"' });
    expect(await store.getMeta()).toEqual({ headCommit: "c1", headTree: "t1", headEtag: '"e"' });
  });

  it("update opretter, ændrer, sletter — og undefined lader posten være", async () => {
    const store = make();
    expect(await store.update("A.md", () => rec("A.md", "a"))).toEqual(rec("A.md", "a"));
    expect(await store.update("A.md", (cur) => ({ ...cur!, content: "b" }))).toMatchObject({ content: "b" });
    expect(await store.update("A.md", () => undefined)).toMatchObject({ content: "b" });
    expect(await store.get("A.md")).toMatchObject({ content: "b" });
    expect(await store.update("A.md", () => null)).toBeUndefined();
    expect(await store.get("A.md")).toBeUndefined();
    expect(await store.update("Findes ikke.md", () => null)).toBeUndefined();
  });

  it("nøglen er altid den bedte sti, også hvis fn returnerer en anden", async () => {
    const store = make();
    await store.update("Rigtig.md", () => rec("Forkert.md", "x"));
    expect(await store.get("Rigtig.md")).toMatchObject({ path: "Rigtig.md", content: "x" });
    expect(await store.get("Forkert.md")).toBeUndefined();
  });

  it("update er atomisk: 50 samtidige optællinger mister ingen", async () => {
    const store = make();
    await Promise.all(
      Array.from({ length: 50 }, () =>
        store.update("tæller.md", (cur) => rec("tæller.md", String(Number(cur?.content ?? "0") + 1)))
      )
    );
    expect((await store.get("tæller.md"))!.content).toBe("50");
  });

  it("kaster fn, afvises kaldet, og intet ændres", async () => {
    const store = make();
    await store.update("A.md", () => rec("A.md", "før"));
    await expect(
      store.update("A.md", () => {
        throw new Error("fn fejlede");
      })
    ).rejects.toThrow("fn fejlede");
    expect((await store.get("A.md"))!.content).toBe("før");
  });

  it("returnerede poster er kopier", async () => {
    const store = make();
    await store.update("A.md", () => rec("A.md", "a"));
    const r = (await store.get("A.md"))!;
    r.content = "ændret udefra";
    expect((await store.get("A.md"))!.content).toBe("a");
  });

  it("clear tømmer både noter og meta", async () => {
    const store = make();
    await store.update("A.md", () => rec("A.md", "a"));
    await store.setMeta({ headCommit: "c", headTree: "t", headEtag: null });
    await store.clear();
    expect(await store.all()).toEqual([]);
    expect(await store.getMeta()).toEqual({ headCommit: null, headTree: null, headEtag: null });
  });

  it("æøå, NFD og mellemrum i stier er forskellige nøgler", async () => {
    const store = make();
    const nfc = "Møde på Ærø.md".normalize("NFC");
    const nfd = nfc.normalize("NFD"); // å deler sig i a + ring
    expect(nfd).not.toBe(nfc);
    await store.update(nfd, () => rec(nfd, "nfd"));
    await store.update(nfc, () => rec(nfc, "nfc"));
    expect((await store.all()).length).toBe(2);
    expect((await store.get(nfd))!.content).toBe("nfd");
  });
});

describe("IndexedDB-detaljer", () => {
  it("ASCII-navne, stores files/meta, version 1 og poster med v: 1", async () => {
    const name = freshName();
    const store = openIdbStore(name);
    await store.update("Mappe/Møde.md", () => rec("Mappe/Møde.md", "x", { sha: "s", base: "x" }));
    await store.setMeta({ headCommit: "c", headTree: "t", headEtag: null });
    const db = await rawOpen(name);
    expect(db.version).toBe(1);
    expect([...db.objectStoreNames].sort()).toEqual(["files", "meta"]);
    expect(await rawGet(db, "files", "Mappe/Møde.md")).toEqual({
      v: 1,
      path: "Mappe/Møde.md",
      sha: "s",
      base: "x",
      content: "x",
      deleted: false,
      mtime: 1,
    });
    expect(await rawGet(db, "meta", "sync")).toMatchObject({ v: 1, headCommit: "c" });
    db.close();
    // v-feltet lækker ikke ud af LocalStore
    expect(await store.get("Mappe/Møde.md")).not.toHaveProperty("v");
  });

  it("sent (det, et igangværende commit sendte) gemmes og læses; uden sent er posten som før", async () => {
    const name = freshName();
    const store = openIdbStore(name);
    await store.update("A.md", () => rec("A.md", "x", { sha: "s", base: "b", sent: "x" }));
    expect(await openIdbStore(name).get("A.md")).toEqual(rec("A.md", "x", { sha: "s", base: "b", sent: "x" }));
    await store.update("A.md", (cur) => {
      const { sent: _sent, ...rest } = cur!;
      return rest;
    });
    expect(await store.get("A.md")).not.toHaveProperty("sent");
    const db = await rawOpen(name);
    expect(await rawGet(db, "files", "A.md")).not.toHaveProperty("sent");
    db.close();
  });

  it("tabt forbindelse (lukket db → InvalidStateError) genåbnes, og kaldet lykkes", async () => {
    const getDb = captureDb();
    const store = openIdbStore(freshName());
    await store.update("A.md", () => rec("A.md", "a"));
    getDb().close(); // som når iOS mister forbindelsen til IndexedDB-serveren
    expect((await store.get("A.md"))!.content).toBe("a");
    await store.update("A.md", (cur) => ({ ...cur!, content: "b" }));
    expect((await store.get("A.md"))!.content).toBe("b");
  });

  it("UnknownError ('Connection to Indexed Database server lost') → genåbn og prøv én gang til", async () => {
    const getDb = captureDb();
    const store = openIdbStore(freshName());
    await store.update("A.md", () => rec("A.md", "a"));
    const db = getDb();
    const original = db.transaction.bind(db);
    let failures = 0;
    db.transaction = ((...args: Parameters<IDBDatabase["transaction"]>) => {
      if (failures++ === 0) throw new DOMException("Connection to Indexed Database server lost", "UnknownError");
      return original(...args);
    }) as IDBDatabase["transaction"];
    await store.update("A.md", (cur) => ({ ...cur!, content: "efter genåbning" }));
    expect((await store.get("A.md"))!.content).toBe("efter genåbning");
    expect(failures).toBe(1);
  });

  it("fejler det igen efter genåbning, afvises kaldet (kun ét genforsøg)", async () => {
    const getDb = captureDb();
    const store = openIdbStore(freshName());
    await store.get("A.md");
    const proto = Object.getPrototypeOf(getDb()) as IDBDatabase;
    const spy = vi.spyOn(proto, "transaction").mockImplementation(() => {
      throw new DOMException("Connection to Indexed Database server lost", "UnknownError");
    });
    await expect(store.get("A.md")).rejects.toMatchObject({ name: "UnknownError" });
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
    expect(await store.get("A.md")).toBeUndefined(); // og bagefter virker den igen
  });

  it("deleteIdbDatabase lukker åbne forbindelser (versionchange) og nulstiller", async () => {
    const name = freshName();
    const store = openIdbStore(name);
    await store.update("A.md", () => rec("A.md", "a"));
    await deleteIdbDatabase(name); // må ikke blive blokeret af store'ens åbne forbindelse
    expect(await store.get("A.md")).toBeUndefined();
    await store.update("B.md", () => rec("B.md", "b"));
    expect((await store.all()).map((r) => r.path)).toEqual(["B.md"]);
  });
});

describe("synk-motoren over IndexedDB", () => {
  it("første hentning, lokal ændring, push og næste synk", async () => {
    const initial: Record<string, string> = { "billede.png": "x" };
    for (let i = 0; i < 120; i++) initial[`Mappe ${i % 5}/Note ${i} æøå.md`] = `# Note ${i}\n\ntekst\n`;
    const remote = createFakeRemote(initial);
    const store = openIdbStore(freshName());
    const engine = createSyncEngine(store, remote.api, { sleep: async () => {} });
    expect(await engine.sync()).toMatchObject({ status: "ok", initial: true });
    expect((await store.all()).length).toBe(120);

    await store.update("Mappe 0/Note 0 æøå.md", (cur) => ({ ...cur!, content: "# Note 0\n\nændret\n" }));
    remote.commitFromDesktop({ "Mappe 1/Note 1 æøå.md": "# Note 1\n\nfra computeren\n" });
    const res = await engine.sync();
    expect(res).toMatchObject({ status: "ok", committed: 1, changedPaths: ["Mappe 1/Note 1 æøå.md"] });
    expect(remote.files()["Mappe 0/Note 0 æøå.md"]).toBe("# Note 0\n\nændret\n");
    expect((await store.get("Mappe 1/Note 1 æøå.md"))!.content).toBe("# Note 1\n\nfra computeren\n");
    expect(await engine.sync()).toMatchObject({ status: "ok", committed: 0, changedPaths: [] });
  });
});
