import { describe, expect, it } from "vitest";
import { gitBlobSha } from "./blobSha";
import { createFakeRemote, type FakeRemote } from "./fakeRemote";
import { createMemoryStore } from "./localStore";
import { commitMessage, createSyncEngine, isNoteFile, pathKey } from "./syncEngine";
import { GitHubError, isDirty, type FileRecord, type GitHubApi, type LocalStore, type SyncOutcome } from "./types";

function setup(initial: Record<string, string>, api?: (remote: FakeRemote) => GitHubApi) {
  const remote = createFakeRemote(initial);
  const store = createMemoryStore();
  const progress: [number, number][] = [];
  const sleeps: number[] = [];
  const engine = createSyncEngine(store, api ? api(remote) : remote.api, {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => 1000,
    onProgress: (done, total) => progress.push([done, total]),
  });
  return { remote, store, engine, progress, sleeps };
}

// UI-handlingerne, som web-backenden laver dem
async function write(store: LocalStore, path: string, content: string) {
  await store.update(path, (cur) =>
    cur
      ? { ...cur, content, deleted: false, mtime: 2000 }
      : { path, sha: null, base: null, content, deleted: false, mtime: 2000 }
  );
}

async function remove(store: LocalStore, path: string) {
  await store.update(path, (cur) => (!cur ? undefined : cur.sha ? { ...cur, deleted: true } : null));
}

async function rename(store: LocalStore, from: string, to: string) {
  const cur = await store.get(from);
  await remove(store, from);
  await write(store, to, cur!.content!);
}

// synlige noter (ikke slettede) → indhold
async function notes(store: LocalStore): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const r of await store.all()) if (!r.deleted) out[r.path] = r.content;
  return out;
}

async function expectClean(store: LocalStore, path: string, content: string) {
  const r = (await store.get(path)) as FileRecord;
  expect(r).toBeDefined();
  expect(r.content).toBe(content);
  expect(r.base).toBe(content);
  expect(r.sha).toBe(await gitBlobSha(content));
  expect(isDirty(r)).toBe(false);
}

const mobileCommits = (remote: FakeRemote) => remote.log().filter((c) => c.by === "mobil");

const VAULT = {
  "Indbakke/Møde om æøå.md": "# Møde\n\nNoget\n",
  "Arbejde/1 Projects/Plan.md": "plan\n",
  "README.MD": "store bogstaver\n",
  "billede.png": "binært",
  "rapport.html": "<html>",
  ".obsidian/workspace.md": "skjult",
  "Arbejde/.fuse_hidden0001": "kopi",
  "Mappe/.skjult/Note.md": "skjult mappe",
  ".gitignore": "Lokalt/",
};

describe("isNoteFile og hjælpere", () => {
  it("kender kun .md uden skjulte segmenter, som desktopens collect_md", () => {
    expect(isNoteFile("A.md")).toBe(true);
    expect(isNoteFile("Mappe/Under/Note.MD")).toBe(true);
    expect(isNoteFile("Møde med Åse.md")).toBe(true);
    expect(isNoteFile("billede.png")).toBe(false);
    expect(isNoteFile("noter.md.txt")).toBe(false);
    expect(isNoteFile(".obsidian/x.md")).toBe(false);
    expect(isNoteFile("Mappe/.skjult/x.md")).toBe(false);
    expect(isNoteFile("Mappe/.x.md")).toBe(false);
    expect(isNoteFile("Arbejde/.fuse_hidden0001")).toBe(false);
  });

  it("commit-beskeden ligner desktopens, men er markeret mobil", () => {
    expect(commitMessage(["A.md"])).toBe("Noter (mobil): A");
    expect(commitMessage(["x/A.md", "B.md", "y/z/C.md", "D.md", "E.md"])).toBe(
      "Noter (mobil): A, B, C (+2 flere)"
    );
  });

  it("pathKey sammenligner NFC/NFD og store/små bogstaver ens", () => {
    const nfd = "Åen.md".normalize("NFD");
    expect(nfd).not.toBe("Åen.md".normalize("NFC"));
    expect(pathKey(nfd)).toBe(pathKey("åen.md".normalize("NFC")));
  });
});

describe("første hentning", () => {
  it("henter kun noterne, med fremdrift, uden at rapportere ændrede stier", async () => {
    const { remote, store, engine, progress } = setup(VAULT);
    const res = await engine.sync();
    expect(res).toMatchObject({ status: "ok", initial: true, committed: 0, changedPaths: [] });
    expect(Object.keys(await notes(store)).sort()).toEqual(
      ["Arbejde/1 Projects/Plan.md", "Indbakke/Møde om æøå.md", "README.MD"].sort()
    );
    await expectClean(store, "Indbakke/Møde om æøå.md", "# Møde\n\nNoget\n");
    expect(progress.at(-1)).toEqual([3, 3]);
    expect(remote.stats.blobsFetched).toBe(3);
    const meta = await store.getMeta();
    expect(meta.headCommit).toBe(remote.head());
    expect(meta.headEtag).toBe(`"${remote.head()}"`);
  });

  it("anden synk uden ændringer koster kun et uændret head-opslag", async () => {
    const { remote, engine } = setup(VAULT);
    await engine.sync();
    const res = await engine.sync();
    expect(res).toMatchObject({ status: "ok", initial: false, committed: 0, changedPaths: [] });
    expect(remote.stats.notModified).toBe(1);
    expect(remote.stats.getTree).toBe(1);
    expect(remote.stats.commitCalls).toBe(0);
  });
});

describe("pull", () => {
  it("ren fjernændring og ny fjernfil hentes og rapporteres", async () => {
    const { remote, store, engine } = setup({ "A.md": "a\n" });
    await engine.sync();
    remote.commitFromDesktop({ "A.md": "a ændret\n", "Ny/B.md": "b\n" });
    const res = await engine.sync();
    expect(res.status).toBe("ok");
    expect(res.changedPaths.sort()).toEqual(["A.md", "Ny/B.md"]);
    await expectClean(store, "A.md", "a ændret\n");
    await expectClean(store, "Ny/B.md", "b\n");
    expect(remote.stats.commitCalls).toBe(0);
  });

  it("fjernændring + lokal ændring i forskellige blokke flettes og sendes", async () => {
    const { remote, store, engine } = setup({ "A.md": "Første\n\nAnden\n\nTredje\n" });
    await engine.sync();
    remote.commitFromDesktop({ "A.md": "Første ændret\n\nAnden\n\nTredje\n" });
    await write(store, "A.md", "Første\n\nAnden\n\nTredje lokalt\n");
    const res = await engine.sync();
    const merged = "Første ændret\n\nAnden\n\nTredje lokalt\n";
    expect(res).toMatchObject({ status: "ok", committed: 1, changedPaths: ["A.md"] });
    expect(remote.files()["A.md"]).toBe(merged);
    await expectClean(store, "A.md", merged);
    expect(mobileCommits(remote)).toHaveLength(1);
  });

  it("begge ændrer samme blok: begge versioner bevares, min først", async () => {
    const { remote, store, engine } = setup({ "A.md": "Linje\n" });
    await engine.sync();
    remote.commitFromDesktop({ "A.md": "Linje fra computeren\n" });
    await write(store, "A.md", "Linje fra telefonen\n");
    await engine.sync();
    const merged = "Linje fra telefonen\n\nLinje fra computeren\n";
    expect(remote.files()["A.md"]).toBe(merged);
    await expectClean(store, "A.md", merged);
  });

  it("fjernslettet ren fil forsvinder; fjernslettet beskidt fil bevares og sendes igen", async () => {
    const { remote, store, engine } = setup({ "A.md": "a\n", "B.md": "b\n", "C.md": "c\n" });
    await engine.sync();
    await write(store, "B.md", "b lokalt\n");
    remote.commitFromDesktop({ "A.md": null, "B.md": null });
    const res = await engine.sync();
    expect(res.status).toBe("ok");
    expect(res.changedPaths).toEqual(["A.md"]);
    expect(await store.get("A.md")).toBeUndefined();
    expect(remote.files()).toEqual({ "B.md": "b lokalt\n", "C.md": "c\n" });
    await expectClean(store, "B.md", "b lokalt\n");
  });

  it("lokal sletning mod fjernændring: den ændrede version vinder", async () => {
    const { remote, store, engine } = setup({ "A.md": "a\n" });
    await engine.sync();
    await remove(store, "A.md");
    remote.commitFromDesktop({ "A.md": "a fra computeren\n" });
    const res = await engine.sync();
    expect(res).toMatchObject({ status: "ok", committed: 0, changedPaths: ["A.md"] });
    await expectClean(store, "A.md", "a fra computeren\n");
    expect(remote.files()["A.md"]).toBe("a fra computeren\n");
  });

  it("omdøbning på computeren genbruger den kendte tekst i stedet for at hente den", async () => {
    const { remote, store, engine } = setup({ "A.md": "a\n" });
    await engine.sync();
    const fetched = remote.stats.blobsFetched;
    remote.commitFromDesktop({ "A.md": null, "Mappe/A2.md": "a\n" });
    const res = await engine.sync();
    expect(res.changedPaths.sort()).toEqual(["A.md", "Mappe/A2.md"]);
    expect(remote.stats.blobsFetched).toBe(fetched);
    expect(await notes(store)).toEqual({ "Mappe/A2.md": "a\n" });
  });

  it("ændringer i ikke-md-filer og skjulte stier hentes aldrig og bevares ved push", async () => {
    const { remote, store, engine } = setup(VAULT);
    await engine.sync();
    const fetched = remote.stats.blobsFetched;
    remote.commitFromDesktop({ "billede.png": "nyt billede", ".obsidian/workspace.md": "ændret", "Ny.txt": "x" });
    const pulled = await engine.sync();
    expect(pulled.changedPaths).toEqual([]);
    expect(remote.stats.blobsFetched).toBe(fetched);
    await write(store, "README.MD", "ny tekst\n");
    await engine.sync();
    const files = remote.files();
    expect(files["billede.png"]).toBe("nyt billede");
    expect(files[".obsidian/workspace.md"]).toBe("ændret");
    expect(files["Arbejde/.fuse_hidden0001"]).toBe("kopi");
    expect(files["Mappe/.skjult/Note.md"]).toBe("skjult mappe");
    expect(files[".gitignore"]).toBe("Lokalt/");
    expect(files["README.MD"]).toBe("ny tekst\n");
    expect(Object.keys(await notes(store))).not.toContain(".obsidian/workspace.md");
  });
});

describe("push", () => {
  it("lokal ny, omdøbt og slettet fil sendes i ét commit", async () => {
    const { remote, store, engine } = setup({ "A.md": "a\n", "B.md": "b\n", "C.md": "c\n" });
    await engine.sync();
    await write(store, "Indbakke/Ny note.md", "ny\n");
    await rename(store, "A.md", "Mappe/A2.md");
    await remove(store, "C.md");
    const res = await engine.sync();
    expect(res).toMatchObject({ status: "ok", committed: 4 });
    const commits = mobileCommits(remote);
    expect(commits).toHaveLength(1);
    expect(commits[0].message).toBe("Noter (mobil): Ny note, A2, A (+1 flere)");
    expect(remote.files()).toEqual({ "B.md": "b\n", "Mappe/A2.md": "a\n", "Indbakke/Ny note.md": "ny\n" });
    expect(Object.keys(await notes(store)).sort()).toEqual(["B.md", "Indbakke/Ny note.md", "Mappe/A2.md"]);
    expect((await store.all()).length).toBe(3); // slettede poster er væk
    await expectClean(store, "Indbakke/Ny note.md", "ny\n");
    await expectClean(store, "Mappe/A2.md", "a\n");
    expect((await store.getMeta()).headCommit).toBe(remote.head());
    // og bagefter er der intet at sende
    const again = await engine.sync();
    expect(again).toMatchObject({ status: "ok", committed: 0 });
    expect(remote.stats.commitCalls).toBe(1);
  });

  it("efter eget push huskes ETag'en ved næste synk, så opslaget derefter er gratis (304)", async () => {
    const { remote, store, engine } = setup({ "A.md": "a\n" });
    await engine.sync();
    await write(store, "A.md", "a lokalt\n");
    await engine.sync();
    const trees = remote.stats.getTree;
    await engine.sync();
    expect((await store.getMeta()).headEtag).toBe(`"${remote.head()}"`);
    const before = remote.stats.notModified;
    await engine.sync();
    expect(remote.stats.notModified).toBe(before + 1);
    expect(remote.stats.getTree).toBe(trees);
  });

  it("stier med æøå og mellemrum sendes præcis som de er", async () => {
    const { remote, store, engine } = setup({});
    await engine.sync();
    await write(store, "Arbejde/Møde med Åse på Ærø.md", "hej\n");
    await engine.sync();
    expect(remote.files()).toEqual({ "Arbejde/Møde med Åse på Ærø.md": "hej\n" });
  });

  it("slettet lokal fil, der aldrig var på GitHub, fjernes uden commit", async () => {
    const { remote, store, engine } = setup({ "A.md": "a\n" });
    await engine.sync();
    await store.update("Kladde.md", () => ({
      path: "Kladde.md",
      sha: null,
      base: null,
      content: "x",
      deleted: true,
      mtime: 1,
    }));
    const res = await engine.sync();
    expect(res).toMatchObject({ status: "ok", committed: 0 });
    expect(await store.get("Kladde.md")).toBeUndefined();
    expect(remote.stats.commitCalls).toBe(0);
  });

  it("sletning af en sti, der også er slettet på GitHub, sendes ikke", async () => {
    const { remote, store, engine } = setup({ "A.md": "a\n", "B.md": "b\n" });
    await engine.sync();
    await remove(store, "A.md");
    await write(store, "B.md", "b lokalt\n");
    remote.commitFromDesktop({ "A.md": null });
    const res = await engine.sync();
    // fakeRemote afviser (som GitHub) hele commit'et, hvis A.md blev sendt som sletning
    expect(res).toMatchObject({ status: "ok", committed: 1 });
    expect(remote.files()).toEqual({ "B.md": "b lokalt\n" });
    expect(await store.get("A.md")).toBeUndefined();
  });
});

describe("samtidighed og genforsøg", () => {
  it("stale: computeren committer mellem pull og push → nyt forsøg lykkes, intet tabes", async () => {
    const { remote, store, engine, sleeps } = setup({ "A.md": "Top\n\nMidte\n\nBund\n", "B.md": "b\n" });
    await engine.sync();
    await write(store, "A.md", "Top fra telefonen\n\nMidte\n\nBund\n");
    remote.hooks.beforeCommit = (n) => {
      if (n === 1) {
        remote.commitFromDesktop({
          "A.md": "Top\n\nMidte\n\nBund fra computeren\n",
          "B.md": "b ændret\n",
          "C.md": "c\n",
        });
      }
    };
    const res = await engine.sync();
    expect(res).toMatchObject({ status: "ok", committed: 1 });
    expect(res.changedPaths.sort()).toEqual(["A.md", "B.md", "C.md"]);
    expect(remote.stats.commitCalls).toBe(2);
    expect(remote.stats.commits).toBe(1);
    expect(sleeps).toHaveLength(1);
    expect(remote.files()).toEqual({
      "A.md": "Top fra telefonen\n\nMidte\n\nBund fra computeren\n",
      "B.md": "b ændret\n",
      "C.md": "c\n",
    });
    await expectClean(store, "A.md", "Top fra telefonen\n\nMidte\n\nBund fra computeren\n");
    await expectClean(store, "B.md", "b ændret\n");
    expect((await store.getMeta()).headCommit).toBe(remote.head());
  });

  it("falsk stale (head uændret): venter og prøver igen uden ny hentning", async () => {
    const { remote, store, engine, sleeps } = setup({ "A.md": "a\n" });
    await engine.sync();
    await write(store, "A.md", "a lokalt\n");
    remote.staleNext(1);
    const trees = remote.stats.getTree;
    const res = await engine.sync();
    expect(res).toMatchObject({ status: "ok", committed: 1 });
    expect(remote.stats.commitCalls).toBe(2);
    expect(remote.stats.getTree).toBe(trees);
    expect(sleeps.length).toBe(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(500);
    expect(remote.files()["A.md"]).toBe("a lokalt\n");
  });

  it("stale tre gange i træk giver konflikt; ændringerne bliver liggende og sendes næste gang", async () => {
    const { remote, store, engine, sleeps } = setup({ "A.md": "a\n" });
    await engine.sync();
    await write(store, "A.md", "a lokalt\n");
    remote.staleNext(3);
    const res = await engine.sync();
    expect(res.status).toBe("conflict");
    expect(res.detail).toMatch(/gemt på telefonen/);
    expect(remote.stats.commitCalls).toBe(3);
    expect(sleeps).toHaveLength(2);
    const r = (await store.get("A.md"))!;
    expect(r.content).toBe("a lokalt\n");
    expect(isDirty(r)).toBe(true);
    expect((await engine.sync()).status).toBe("ok");
    expect(remote.files()["A.md"]).toBe("a lokalt\n");
  });

  it("skrivning fra UI'et midt i hentningen overlever og kommer med i push", async () => {
    const { remote, store, engine } = setup({ "A.md": "Top\n\nMidte\n\nBund\n" });
    await engine.sync();
    remote.commitFromDesktop({ "A.md": "Top\n\nMidte\n\nBund fra computeren\n" });
    remote.hooks.onBlobFetch = () => write(store, "A.md", "Top fra telefonen\n\nMidte\n\nBund\n");
    const res = await engine.sync();
    const merged = "Top fra telefonen\n\nMidte\n\nBund fra computeren\n";
    expect(res).toMatchObject({ status: "ok", committed: 1 });
    expect(remote.files()["A.md"]).toBe(merged);
    await expectClean(store, "A.md", merged);
  });

  it("skrivning fra UI'et under push forbliver beskidt og sendes ved næste synk", async () => {
    const { remote, store, engine } = setup({ "A.md": "a\n" });
    await engine.sync();
    await write(store, "A.md", "v1\n");
    remote.hooks.beforeCommit = () => write(store, "A.md", "v2\n");
    await engine.sync();
    expect(remote.files()["A.md"]).toBe("v1\n");
    const r = (await store.get("A.md"))!;
    expect(r).toMatchObject({ content: "v2\n", base: "v1\n", sha: await gitBlobSha("v1\n") });
    expect(isDirty(r)).toBe(true);
    remote.hooks.beforeCommit = undefined;
    await engine.sync();
    expect(remote.files()["A.md"]).toBe("v2\n");
    await expectClean(store, "A.md", "v2\n");
  });

  it("ny note slettet under push bliver slettet på GitHub ved næste synk", async () => {
    const { remote, store, engine } = setup({ "A.md": "a\n" });
    await engine.sync();
    await write(store, "Ny.md", "ny\n");
    remote.hooks.beforeCommit = () => remove(store, "Ny.md");
    await engine.sync();
    expect(remote.files()["Ny.md"]).toBe("ny\n");
    expect(await store.get("Ny.md")).toMatchObject({ deleted: true, sha: await gitBlobSha("ny\n") });
    expect(await notes(store)).toEqual({ "A.md": "a\n" });
    remote.hooks.beforeCommit = undefined;
    await engine.sync();
    expect(remote.files()).toEqual({ "A.md": "a\n" });
    expect(await store.get("Ny.md")).toBeUndefined();
  });

  it("note genskabt under push af dens sletning bliver en ny lokal fil", async () => {
    const { remote, store, engine } = setup({ "A.md": "a\n" });
    await engine.sync();
    await remove(store, "A.md");
    remote.hooks.beforeCommit = () => write(store, "A.md", "igen\n");
    await engine.sync();
    expect(remote.files()).toEqual({});
    expect(await store.get("A.md")).toMatchObject({ sha: null, base: null, content: "igen\n", deleted: false });
    remote.hooks.beforeCommit = undefined;
    await engine.sync();
    expect(remote.files()).toEqual({ "A.md": "igen\n" });
  });

  it("kører aldrig to synk samtidig; kald under en synk deler én ny synk bagefter", async () => {
    let active = 0;
    let maxActive = 0;
    const { remote, store, engine } = setup({ "A.md": "a\n" }, (remote) => {
      const wrap =
        <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
        async (...args: A): Promise<R> => {
          active++;
          maxActive = Math.max(maxActive, active);
          try {
            await new Promise((r) => setTimeout(r, 2));
            return await fn(...args);
          } finally {
            active--;
          }
        };
      const a = remote.api;
      return {
        getHead: wrap(a.getHead),
        getTree: wrap(a.getTree),
        getBlobTexts: wrap(a.getBlobTexts),
        commit: wrap(a.commit),
      };
    });
    await engine.sync();
    remote.commitFromDesktop({ "A.md": "a ændret\n" });
    const later: { second?: Promise<SyncOutcome>; third?: Promise<SyncOutcome> } = {};
    remote.hooks.onBlobFetch = async () => {
      later.second = engine.sync();
      later.third = engine.sync();
      await write(store, "Ny.md", "skrevet under første synk\n");
    };
    const first = engine.sync();
    const r1 = await first;
    remote.hooks.onBlobFetch = undefined;
    expect(later.second).toBeDefined();
    expect(later.second).toBe(later.third);
    expect(later.second).not.toBe(first);
    const r2 = await later.second!;
    expect(r1.status).toBe("ok");
    expect(r2.status).toBe("ok");
    expect(maxActive).toBe(1);
    expect(remote.files()["Ny.md"]).toBe("skrevet under første synk\n");
    expect(mobileCommits(remote)).toHaveLength(1);
  });
});

describe("stier og bytes", () => {
  it("NFD-sti på GitHub + samme navn oprettet lokalt i NFC → én fil med GitHubs sti", async () => {
    const nfd = "Dagbog/Øl og æbler på Ærø.md".normalize("NFD");
    const nfc = nfd.normalize("NFC");
    expect(nfd).not.toBe(nfc);
    const { remote, store, engine } = setup({ "A.md": "a\n" });
    await engine.sync();
    remote.commitFromDesktop({ [nfd]: "fra computeren\n" });
    await write(store, nfc, "fra telefonen\n");
    const res = await engine.sync();
    const merged = "fra telefonen\n\nfra computeren\n";
    expect(res.status).toBe("ok");
    expect(res.changedPaths).toContain(nfd);
    expect(await store.get(nfc)).toBeUndefined();
    await expectClean(store, nfd, merged);
    expect(Object.keys(remote.files()).sort()).toEqual(["A.md", nfd].sort());
    expect(remote.files()[nfd]).toBe(merged);
  });

  it("NFD-sti fra GitHub redigeres og sendes under sin originale sti", async () => {
    const nfd = "Møde på Ærø.md".normalize("NFD");
    const { remote, store, engine } = setup({ [nfd]: "x\n" });
    await engine.sync();
    await write(store, nfd, "y\n");
    await engine.sync();
    expect(remote.files()).toEqual({ [nfd]: "y\n" });
  });

  it("samme navn oprettet begge steder med samme indhold giver ingen dublet og intet commit", async () => {
    const { remote, store, engine } = setup({});
    await engine.sync();
    remote.commitFromDesktop({ "Indbakke/Idé.md": "samme\n" });
    await write(store, "indbakke/idé.md", "samme\n");
    const res = await engine.sync();
    expect(res).toMatchObject({ status: "ok", committed: 0 });
    expect(await notes(store)).toEqual({ "Indbakke/Idé.md": "samme\n" });
  });

  it("BOM og CRLF bevares byte for byte begge veje", async () => {
    const bom = "﻿# Titel\r\n\r\nTekst\r\n";
    const crlf = "a\r\nb\r\n";
    const { remote, store, engine } = setup({ "Bom.md": bom, "Crlf.md": crlf });
    await engine.sync();
    await expectClean(store, "Bom.md", bom);
    await expectClean(store, "Crlf.md", crlf);

    await write(store, "Crlf.md", "a\r\nb\r\nc\r\n");
    await engine.sync();
    expect(remote.files()["Crlf.md"]).toBe("a\r\nb\r\nc\r\n");
    expect(remote.files()["Bom.md"]).toBe(bom);

    remote.commitFromDesktop({ "Bom.md": "﻿# Titel\r\n\r\nNy tekst\r\n" });
    await engine.sync();
    await expectClean(store, "Bom.md", "﻿# Titel\r\n\r\nNy tekst\r\n");
  });
});

describe("fejl", () => {
  it("offline midt i hentningen efterlader alt lokalt, og næste synk gør arbejdet færdigt", async () => {
    const { remote, store, engine } = setup({ "A.md": "a\n", "B.md": "b\n" });
    await engine.sync();
    const metaBefore = await store.getMeta();
    await write(store, "A.md", "a lokalt\n");
    remote.commitFromDesktop({ "B.md": "b ændret\n" });
    remote.hooks.onBlobFetch = () => remote.setOffline(true);
    const res = await engine.sync();
    expect(res.status).toBe("offline");
    expect(res.detail).toMatch(/gemt på telefonen/);
    expect((await store.get("A.md"))!.content).toBe("a lokalt\n");
    await expectClean(store, "B.md", "b\n");
    expect(await store.getMeta()).toEqual(metaBefore);
    expect(remote.stats.commitCalls).toBe(0);

    remote.hooks.onBlobFetch = undefined;
    remote.setOffline(false);
    const again = await engine.sync();
    expect(again).toMatchObject({ status: "ok", committed: 1, changedPaths: ["B.md"] });
    expect(remote.files()).toEqual({ "A.md": "a lokalt\n", "B.md": "b ændret\n" });
  });

  it("offline fra start", async () => {
    const { remote, store, engine } = setup({ "A.md": "a\n" });
    remote.setOffline(true);
    const res = await engine.sync();
    expect(res).toMatchObject({ status: "offline", initial: true, committed: 0, changedPaths: [] });
    expect(await store.all()).toEqual([]);
  });

  it("tabt svar på et commit: næste synk retter op uden dubletter eller nyt commit", async () => {
    const { remote, store, engine } = setup({ "A.md": "Top\n\n\n\nBund\n" });
    await engine.sync();
    await write(store, "A.md", "Top\n\n\n\nBund lokalt\n");
    await write(store, "Ny.md", "ny\n");
    remote.hooks.afterCommit = () => remote.setOffline(true);
    expect((await engine.sync()).status).toBe("offline");
    remote.hooks.afterCommit = undefined;
    remote.setOffline(false);
    const res = await engine.sync();
    expect(res).toMatchObject({ status: "ok", committed: 0 });
    await expectClean(store, "A.md", "Top\n\n\n\nBund lokalt\n");
    await expectClean(store, "Ny.md", "ny\n");
    expect(mobileCommits(remote)).toHaveLength(1);
  });

  it("tabt svar på et commit + videre skrivning: ingen dubletter, og det nye sendes", async () => {
    const { remote, store, engine } = setup({ "A.md": "Top\n\nBund\n" });
    await engine.sync();
    await write(store, "A.md", "Top\n\nBund lokalt\n");
    await write(store, "Ny.md", "ny\n");
    remote.hooks.afterCommit = () => remote.setOffline(true);
    expect((await engine.sync()).status).toBe("offline");
    remote.hooks.afterCommit = undefined;
    remote.setOffline(false);
    // brugeren skriver videre i samme afsnit, før næste synk lykkes
    await write(store, "A.md", "Top\n\nBund lokalt og mere\n");
    await write(store, "Ny.md", "ny og mere\n\nandet afsnit\n");
    const res = await engine.sync();
    expect(res).toMatchObject({ status: "ok", committed: 2, changedPaths: [] });
    await expectClean(store, "A.md", "Top\n\nBund lokalt og mere\n");
    await expectClean(store, "Ny.md", "ny og mere\n\nandet afsnit\n");
    expect(remote.files()["A.md"]).toBe("Top\n\nBund lokalt og mere\n");
    expect(remote.files()["Ny.md"]).toBe("ny og mere\n\nandet afsnit\n");
    expect(mobileCommits(remote)).toHaveLength(2);
    expect((await store.all()).every((r) => r.sent === undefined || r.sent === null)).toBe(true);
  });

  it("tabt svar, og noten slettes lokalt bagefter: sletningen sendes, noten genopstår ikke", async () => {
    const { remote, store, engine } = setup({ "A.md": "a\n" });
    await engine.sync();
    await write(store, "A.md", "a ændret\n");
    remote.hooks.afterCommit = () => remote.setOffline(true);
    expect((await engine.sync()).status).toBe("offline");
    remote.hooks.afterCommit = undefined;
    remote.setOffline(false);
    await remove(store, "A.md");
    expect(await engine.sync()).toMatchObject({ status: "ok", committed: 1 });
    expect(remote.files()).toEqual({});
    expect(await store.all()).toEqual([]);
  });

  it("commit der aldrig landede + fortrudt lokalt: computerens senere ændring vinder", async () => {
    const { remote, store, engine } = setup({ "A.md": "- [ ] x\n" });
    await engine.sync();
    await write(store, "A.md", "- [x] x\n");
    remote.hooks.beforeCommit = () => remote.setOffline(true);
    expect((await engine.sync()).status).toBe("offline");
    remote.hooks.beforeCommit = undefined;
    remote.setOffline(false);
    await write(store, "A.md", "- [ ] x\n"); // fortrudt: ren igen
    remote.commitFromDesktop({ "A.md": "- [x] x\n" }); // computeren krydser af
    expect((await engine.sync()).status).toBe("ok");
    await expectClean(store, "A.md", "- [x] x\n");
    expect(remote.files()["A.md"]).toBe("- [x] x\n");
  });

  it("tabt svar, men computeren har ændret noten oven på: fletningen mister intet", async () => {
    const { remote, store, engine } = setup({ "A.md": "Top\n\nMidt\n\nBund\n" });
    await engine.sync();
    await write(store, "A.md", "Top lokalt\n\nMidt\n\nBund\n");
    remote.hooks.afterCommit = () => remote.setOffline(true);
    expect((await engine.sync()).status).toBe("offline");
    remote.hooks.afterCommit = undefined;
    remote.setOffline(false);
    remote.commitFromDesktop({ "A.md": "Top lokalt\n\nMidt\n\nBund fra computeren\n" });
    expect((await engine.sync()).status).toBe("ok");
    await expectClean(store, "A.md", "Top lokalt\n\nMidt\n\nBund fra computeren\n");
  });

  it("GitHub-fejl bliver til danske beskeder, og lokale ændringer bevares", async () => {
    const { remote, store, engine } = setup({ "A.md": "a\n" });
    await engine.sync();
    await write(store, "A.md", "a lokalt\n");

    remote.failWith("auth");
    expect(await engine.sync()).toMatchObject({
      status: "error",
      detail: "Adgangsnøglen virker ikke længere. Indsæt en ny under Indstillinger.",
    });
    remote.failWith("rate-limit");
    expect((await engine.sync()).detail).toMatch(/GitHub beder os vente lidt/);
    remote.failWith(null);

    remote.hooks.beforeCommit = () => {
      throw new GitHubError("forbidden", "Resource not accessible by personal access token", 403);
    };
    expect(await engine.sync()).toMatchObject({ status: "error", detail: "Nøglen har ikke skriveadgang til repoet." });
    remote.hooks.beforeCommit = () => {
      throw new GitHubError("other", "GitHub svarede 502");
    };
    expect(await engine.sync()).toMatchObject({ status: "error", detail: "GitHub svarede 502" });

    const r = (await store.get("A.md"))!;
    expect(r.content).toBe("a lokalt\n");
    expect(isDirty(r)).toBe(true);
    remote.hooks.beforeCommit = undefined;
    expect((await engine.sync()).status).toBe("ok");
    expect(remote.files()["A.md"]).toBe("a lokalt\n");
  });

  it("en fejl i det lokale lager bliver til status error, ikke en undtagelse", async () => {
    const { remote } = setup({ "A.md": "a\n" });
    const broken = createMemoryStore();
    broken.getMeta = async () => {
      throw new Error("Lageret er væk");
    };
    const res = await createSyncEngine(broken, remote.api, { sleep: async () => {} }).sync();
    expect(res).toMatchObject({ status: "error", detail: "Lageret er væk" });
  });
});

describe("store.update som synk-motoren bruger den", () => {
  it("mange noter ved første hentning (fremdrift når helt op)", async () => {
    const initial: Record<string, string> = {};
    for (let i = 0; i < 250; i++) initial[`Mappe ${i % 7}/Note ${i}.md`] = `# Note ${i}\n\ntekst ${i}\n`;
    const { store, engine, progress } = setup(initial);
    const res = await engine.sync();
    expect(res.status).toBe("ok");
    expect(res.detail).toBe("Hentet 250 noter");
    expect((await store.all()).length).toBe(250);
    expect(progress.at(-1)).toEqual([250, 250]);
  });
});
