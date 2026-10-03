import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeRemote, type FakeRemote } from "./fakeRemote";
import { createGitHubBackend, pendingChangesCount } from "./githubBackend";
import { createMemoryStore, openIdbStore } from "./localStore";
import type { GitHubConfig, LocalStore } from "./types";

// Testene kører i node: localStorage, sessionStorage og window.open lægges ind her
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  };
}

let openSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("sessionStorage", memoryStorage());
  openSpy = vi.fn();
  vi.stubGlobal("window", { open: openSpy });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const CFG: GitHubConfig = { owner: "pindulet", repo: "notes", branch: "main", token: "test-noegle", connectedAt: 0 };
const ROOT = "/notes";
const abs = (rel: string) => `${ROOT}/${rel}`;
const PASKE_NFD = "Privat/Påske.md".normalize("NFD");

const STATUS_V0 = "# Statusmøde\n\nAftalt: nyhedsbrev fredag.\n\nDeltagere: Rikke og Ask.\n\nNæste gang: workshop.\n";
// begge ændringer på én gang (forskellige blokke, adskilt af en uændret)
const STATUS_MERGED =
  "# Statusmøde\n\nAftalt: nyhedsbrev torsdag.\n\nDeltagere: Rikke og Ask.\n\nNæste gang: workshop og frokost.\n";

const VAULT: Record<string, string> = {
  "Indbakke.md": "# Indbakke\n\n- Ring til Rikke\n",
  "Arbejde/Statusmøde.md": STATUS_V0,
  "Arbejde/1 Projects/Plan.md": "# Plan\n\nFørste skridt.\n",
  "Privat/Ferie.md": "# Ferie\n",
  [PASKE_NFD]: "# Påske\n",
  "Billeder/kat.png": "PNG",
  ".obsidian/app.json": "{}",
  ".trash/Gammel.md": "# Gammel\n",
};
const NOTE_COUNT = 5;

function setup(initial: Record<string, string> = VAULT, cfg: GitHubConfig | null = CFG) {
  const remote = createFakeRemote(initial);
  const store = createMemoryStore();
  let config = cfg;
  const apisCreated: GitHubConfig[] = [];
  const backend = createGitHubBackend({
    store,
    createApi: (c) => {
      apisCreated.push(c);
      return remote.api;
    },
    loadConfig: () => config,
  });
  const fsEvents: string[][] = [];
  const progress: ({ done: number; total: number } | null)[] = [];
  backend.onFsChange((paths) => fsEvents.push(paths));
  backend.onSyncProgress((p) => progress.push(p));
  return {
    remote,
    store,
    backend,
    fsEvents,
    progress,
    apisCreated,
    setConfig: (c: GitHubConfig | null) => {
      config = c;
    },
  };
}

async function connected(initial: Record<string, string> = VAULT) {
  const env = setup(initial);
  const res = await env.backend.gitSync(ROOT);
  expect(res.status).toBe("ok");
  env.fsEvents.length = 0;
  env.progress.length = 0;
  return env;
}

const mobileCommits = (remote: FakeRemote) => remote.log().filter((c) => c.by === "mobil");
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("opsætning og første synk", () => {
  it("henter alle noter med fremdrift og uden at markere dem som ændret", async () => {
    const { backend, fsEvents, progress } = setup();
    expect(await backend.gitInfo(ROOT)).toBe(true);
    expect(await backend.listFolder(ROOT)).toEqual({ files: [], dirs: [] });

    const res = await backend.gitSync(ROOT);
    expect(res).toEqual({ status: "ok", committed: 0, detail: `Hentet ${NOTE_COUNT} noter` });
    expect(progress[0]).toEqual({ done: 0, total: NOTE_COUNT });
    expect(progress.at(-2)).toEqual({ done: NOTE_COUNT, total: NOTE_COUNT });
    expect(progress.at(-1)).toBeNull();
    expect(fsEvents).toEqual([[]]); // fillisten genindlæses, ingen prikker

    const listing = await backend.listFolder(ROOT);
    const byPath = Object.fromEntries(listing.files.map((f) => [f.path, f]));
    expect(Object.keys(byPath).sort()).toEqual(
      ["Arbejde/1 Projects/Plan.md", "Arbejde/Statusmøde.md", "Indbakke.md", "Privat/Ferie.md", PASKE_NFD]
        .map(abs)
        .sort()
    );
    expect(byPath[abs("Arbejde/Statusmøde.md")]).toMatchObject({ name: "Statusmøde", rel_dir: "Arbejde" });
    expect(byPath[abs("Arbejde/1 Projects/Plan.md")]).toMatchObject({ name: "Plan", rel_dir: "Arbejde/1 Projects" });
    expect(byPath[abs("Indbakke.md")]).toMatchObject({ name: "Indbakke", rel_dir: "" });
    // ikke-noter og skjulte mapper vises ikke
    expect(listing.dirs).toEqual(["Arbejde", "Arbejde/1 Projects", "Privat"]);

    expect(await backend.readFile(abs("Arbejde/Statusmøde.md"))).toBe(STATUS_V0);
    await expect(backend.readFile(abs("Billeder/kat.png"))).rejects.toThrow("Filen findes ikke");
    await expect(backend.readFile(abs(".trash/Gammel.md"))).rejects.toThrow("Filen findes ikke");
  });

  it("uden forbindelse: ingen synk, og stier kan ikke slås op", async () => {
    const { backend } = setup(VAULT, null);
    expect(await backend.gitInfo(ROOT)).toBe(false);
    const res = await backend.gitSync(ROOT);
    expect(res.status).toBe("error");
    expect(res.detail).toContain("ikke forbundet");
    await expect(backend.listFolder(ROOT)).rejects.toThrow();
  });

  it("forbindelsen læses dovent, og ny nøgle giver ny klient", async () => {
    const env = setup(VAULT, null);
    expect(await env.backend.gitInfo(ROOT)).toBe(false);
    env.setConfig(CFG); // opsætningsskærmen gemmer, efter modulet er indlæst
    expect((await env.backend.gitSync(ROOT)).status).toBe("ok");
    expect(env.apisCreated).toHaveLength(1);
    await env.backend.listFolder(ROOT);
    expect(env.apisCreated).toHaveLength(1);
    env.setConfig({ ...CFG, token: "ny-noegle" });
    expect((await env.backend.gitSync(ROOT)).status).toBe("ok");
    expect(env.apisCreated.map((c) => c.token)).toEqual(["test-noegle", "ny-noegle"]);
  });

  it("stier uden for noternes rod afvises", async () => {
    const { backend } = await connected();
    await expect(backend.readFile("/andet/Indbakke.md")).rejects.toThrow();
    await expect(backend.writeFile("/notesx/Indbakke.md", "x")).rejects.toThrow();
  });
});

describe("skrivning og push", () => {
  it("writeFile → gitSync sender ét commit fra mobilen", async () => {
    const { backend, remote, store } = await connected();
    await backend.readFile(abs("Indbakke.md"));
    await backend.writeFile(abs("Indbakke.md"), "# Indbakke\n\n- Ring til Rikke\n- Køb mælk\n");
    expect(await pendingChangesCount(store)).toBe(1);

    const res = await backend.gitSync(ROOT);
    expect(res.status).toBe("ok");
    expect(res.committed).toBe(1);
    const commits = mobileCommits(remote);
    expect(commits).toHaveLength(1);
    expect(commits[0].message).toBe("Noter (mobil): Indbakke");
    expect(remote.files()["Indbakke.md"]).toBe("# Indbakke\n\n- Ring til Rikke\n- Køb mælk\n");
    expect(remote.files()["Billeder/kat.png"]).toBe("PNG"); // resten af repoet er urørt
    expect(await pendingChangesCount(store)).toBe(0);

    expect(await backend.gitSync(ROOT)).toEqual({ status: "ok", committed: 0, detail: "Alt er synket" });
    expect(mobileCommits(remote)).toHaveLength(1);
  });

  it("fjernændring fra computeren giver fs-change med absolut sti og ny tekst", async () => {
    const { backend, remote, fsEvents, progress } = await connected();
    await backend.readFile(abs("Arbejde/Statusmøde.md"));
    const v1 = STATUS_V0.replace("fredag", "torsdag");
    remote.commitFromDesktop({ "Arbejde/Statusmøde.md": v1 });

    const res = await backend.gitSync(ROOT);
    expect(res.status).toBe("ok");
    expect(fsEvents).toEqual([[abs("Arbejde/Statusmøde.md")]]);
    expect(await backend.readFile(abs("Arbejde/Statusmøde.md"))).toBe(v1);
    expect(progress).toEqual([]); // lille hentning: ingen fremdriftslinje
  });

  it("stor hentning senere viser også fremdrift", async () => {
    const { backend, remote, progress } = await connected();
    const many: Record<string, string> = {};
    for (let i = 0; i < 60; i++) many[`Arkiv/Note ${i}.md`] = `# Note ${i}\n`;
    remote.commitFromDesktop(many);
    await backend.gitSync(ROOT);
    expect(progress[0]).toEqual({ done: 0, total: 60 });
    expect(progress.at(-1)).toBeNull();
  });

  it("omdøb og slet sendes i ét commit", async () => {
    const { backend, remote } = await connected();
    const renamed = await backend.renameFile(abs("Arbejde/1 Projects/Plan.md"), "Plan 2026");
    expect(renamed).toBe(abs("Arbejde/1 Projects/Plan 2026.md"));
    await backend.deleteFile(abs("Privat/Ferie.md"));

    await expect(backend.readFile(abs("Arbejde/1 Projects/Plan.md"))).rejects.toThrow("Filen findes ikke");
    expect(await backend.readFile(renamed)).toBe("# Plan\n\nFørste skridt.\n");
    const names = (await backend.listFolder(ROOT)).files.map((f) => f.name);
    expect(names).toContain("Plan 2026");
    expect(names).not.toContain("Plan");
    expect(names).not.toContain("Ferie");

    const res = await backend.gitSync(ROOT);
    expect(res).toMatchObject({ status: "ok", committed: 3 });
    const commits = mobileCommits(remote);
    expect(commits).toHaveLength(1);
    expect(commits[0].message).toContain("Plan 2026");
    expect(commits[0].message).toContain("Ferie");
    const files = remote.files();
    expect(files["Arbejde/1 Projects/Plan 2026.md"]).toBe("# Plan\n\nFørste skridt.\n");
    expect(files["Arbejde/1 Projects/Plan.md"]).toBeUndefined();
    expect(files["Privat/Ferie.md"]).toBeUndefined();
    expect(files[PASKE_NFD]).toBe("# Påske\n");
  });

  it("en ny note, der omdøbes før synk, sendes kun under det nye navn", async () => {
    const { backend, remote } = await connected();
    const p = await backend.createFile(ROOT, "Kladde");
    await backend.writeFile(p, "# Kladde\n");
    await backend.renameFile(p, "Idé");
    await backend.gitSync(ROOT);
    const files = remote.files();
    expect(files["Idé.md"]).toBe("# Kladde\n");
    expect(files["Kladde.md"]).toBeUndefined();
    expect(mobileCommits(remote)[0].message).toBe("Noter (mobil): Idé");
  });

  it("mappen bliver stående, når dens sidste note slettes", async () => {
    const { backend } = await connected();
    await backend.deleteFile(abs("Privat/Ferie.md"));
    await backend.deleteFile(abs(PASKE_NFD));
    const listing = await backend.listFolder(ROOT);
    expect(listing.files.some((f) => f.rel_dir === "Privat")).toBe(false);
    expect(listing.dirs).toContain("Privat");
  });
});

describe("navne", () => {
  it("createFile renser navnet og finder et ledigt navn som desktop", async () => {
    const { backend, remote } = await connected();
    expect(await backend.createFile(ROOT, "Møde/plan: v2?")).toBe(abs("Møde-plan- v2-.md"));
    expect(await backend.createFile(ROOT, "..skjult")).toBe(abs("skjult.md"));
    expect(await backend.createFile(ROOT, "   ")).toBe(abs("Uden titel.md"));
    expect(await backend.createFile(ROOT, "")).toBe(abs("Uden titel 2.md"));
    expect(await backend.createFile(ROOT, "Slut. . ")).toBe(abs("Slut.md"));
    expect(await backend.createFile(ROOT, "Note.md")).toBe(abs("Note.md"));
    expect(await backend.createFile(ROOT, "Note")).toBe(abs("Note 2.md"));
    // samme navn med andre store/små bogstaver eller i NFD-form er optaget
    expect(await backend.createFile(abs("Arbejde"), "statusmøde")).toBe(abs("Arbejde/statusmøde 2.md"));
    expect(await backend.createFile(abs("Privat"), "påske")).toBe(abs("Privat/påske 2.md"));
    expect(await backend.createFile(abs("Privat"), "Påske".normalize("NFD"))).toBe(abs("Privat/Påske 3.md"));

    expect(await backend.readFile(abs("skjult.md"))).toBe("");
    const names = (await backend.listFolder(ROOT)).files.map((f) => f.name);
    expect(names).toEqual(
      expect.arrayContaining(["Møde-plan- v2-", "skjult", "Uden titel", "Note 2", "statusmøde 2"])
    );

    await backend.gitSync(ROOT);
    const files = remote.files();
    expect(files["Privat/Påske 3.md"]).toBe("");
    expect(files[PASKE_NFD]).toBe("# Påske\n");
  });

  it("omdøbning til et optaget navn afvises — også kun store/små bogstaver", async () => {
    const { backend } = await connected();
    await expect(backend.renameFile(abs("Privat/Ferie.md"), "påske")).rejects.toThrow(
      "Der findes allerede en note med det navn"
    );
    await expect(backend.renameFile(abs("Arbejde/Statusmøde.md"), "statusmøde")).rejects.toThrow(
      "Der findes allerede en note med det navn"
    );
    // samme navn (også i en anden Unicode-form) er ingen ændring
    expect(await backend.renameFile(abs("Privat/Ferie.md"), "Ferie")).toBe(abs("Privat/Ferie.md"));
    expect(await backend.renameFile(abs(PASKE_NFD), "Påske")).toBe(abs(PASKE_NFD));
    expect(await backend.renameFile(abs("Privat/Ferie.md"), "Sommer/ferie")).toBe(abs("Privat/Sommer-ferie.md"));
  });

  it("createFolder er lokal og unik, indtil en note gemmes i mappen", async () => {
    const { backend } = await connected();
    expect(await backend.createFolder(ROOT, "Arbejde")).toBe(abs("Arbejde 2"));
    expect(await backend.createFolder(ROOT, "Idéer")).toBe(abs("Idéer"));
    expect(await backend.createFolder(ROOT, "idéer")).toBe(abs("idéer 2"));
    expect(await backend.createFolder(abs("Idéer"), "Under")).toBe(abs("Idéer/Under"));
    let dirs = (await backend.listFolder(ROOT)).dirs;
    expect(dirs).toEqual(expect.arrayContaining(["Arbejde 2", "Idéer", "idéer 2", "Idéer/Under"]));
    const stored = () => JSON.parse(localStorage.getItem("mw.web.dirs")!);
    expect(stored()).toEqual(["Arbejde 2", "Idéer", "idéer 2", "Idéer/Under"]);

    await backend.createFile(abs("Idéer/Under"), "Første");
    dirs = (await backend.listFolder(ROOT)).dirs;
    expect(dirs).toEqual(expect.arrayContaining(["Idéer", "Idéer/Under", "Arbejde 2"]));
    // mapperne med en note i er nu "rigtige" og glemmes som tomme mapper
    expect(stored()).toEqual(["Arbejde 2", "idéer 2"]);
  });

  it("en sti stavet anderledes (NFC i stedet for NFD) rammer samme note og laver ingen dublet", async () => {
    const { backend, remote } = await connected();
    const nfc = abs("Privat/Påske.md".normalize("NFC"));
    expect(nfc).not.toBe(abs(PASKE_NFD));
    expect(await backend.readFile(nfc)).toBe("# Påske\n");
    await backend.writeFile(nfc, "# Påske\n\nÆg.\n");
    expect((await backend.listFolder(ROOT)).files.filter((f) => f.rel_dir === "Privat")).toHaveLength(2);
    await backend.gitSync(ROOT);
    const files = remote.files();
    expect(files[PASKE_NFD]).toBe("# Påske\n\nÆg.\n");
    expect(files["Privat/Påske.md".normalize("NFC")]).toBeUndefined();
  });
});

describe("værn mod forældet skrivning", () => {
  it("fletter, når en synk har ændret noten, siden UI'et læste den", async () => {
    const { backend, remote, fsEvents } = await connected();
    const path = abs("Arbejde/Statusmøde.md");
    expect(await backend.readFile(path)).toBe(STATUS_V0);

    remote.commitFromDesktop({ "Arbejde/Statusmøde.md": STATUS_V0.replace("fredag", "torsdag") });
    await backend.gitSync(ROOT);
    expect(fsEvents).toEqual([[path]]);
    fsEvents.length = 0;

    // UI'et har ikke genindlæst endnu og gemmer en ændring lavet ud fra den gamle tekst
    const mine = STATUS_V0.replace("workshop", "workshop og frokost");
    await backend.writeFile(path, mine);
    const merged = STATUS_MERGED;
    expect(await backend.readFile(path)).toBe(merged);
    await tick();
    expect(fsEvents).toEqual([[path]]); // store'n genindlæser den flettede tekst

    await backend.gitSync(ROOT);
    expect(remote.files()["Arbejde/Statusmøde.md"]).toBe(merged);
  });

  it("gemmer UI'et igen, før det har genindlæst den flettede tekst, tabes fjernændringen ikke", async () => {
    const { backend, remote } = await connected();
    const path = abs("Arbejde/Statusmøde.md");
    await backend.readFile(path);
    remote.commitFromDesktop({ "Arbejde/Statusmøde.md": STATUS_V0.replace("fredag", "torsdag") });
    await backend.gitSync(ROOT);

    const mine = STATUS_V0.replace("workshop", "workshop og frokost");
    await backend.writeFile(path, mine);
    await backend.writeFile(path, `${mine}\nTilføjet bagefter.\n`); // stadig uden at have læst
    expect(await backend.readFile(path)).toBe(`${STATUS_MERGED}\nTilføjet bagefter.\n`);
    // har UI'et læst den flettede tekst, skrives der bare videre
    await backend.writeFile(path, `${STATUS_MERGED}\nTredje.\n`);
    expect(await backend.readFile(path)).toBe(`${STATUS_MERGED}\nTredje.\n`);
  });

  it("ingen fletning, når UI'et har set den seneste tekst", async () => {
    const { backend, fsEvents } = await connected();
    const path = abs("Indbakke.md");
    await backend.readFile(path);
    await backend.writeFile(path, "første\n");
    await backend.writeFile(path, "anden\n");
    await tick();
    expect(await backend.readFile(path)).toBe("anden\n");
    expect(fsEvents).toEqual([]);
  });

  it("en skrivning under synkens hentning overskrives ikke", async () => {
    const { backend, remote } = await connected();
    const path = abs("Arbejde/Statusmøde.md");
    await backend.readFile(path);
    remote.commitFromDesktop({ "Arbejde/Statusmøde.md": STATUS_V0.replace("fredag", "torsdag") });
    const mine = STATUS_V0.replace("workshop", "workshop og frokost");
    remote.hooks.onBlobFetch = async () => {
      remote.hooks.onBlobFetch = undefined;
      await backend.writeFile(path, mine);
    };
    expect((await backend.gitSync(ROOT)).status).toBe("ok");
    const merged = STATUS_MERGED;
    expect(await backend.readFile(path)).toBe(merged);
    expect(remote.files()["Arbejde/Statusmøde.md"]).toBe(merged);
  });
});

describe("offline", () => {
  it("giver status offline og taber intet", async () => {
    const { backend, remote, store } = await connected();
    const path = abs("Indbakke.md");
    await backend.readFile(path);
    await backend.writeFile(path, "# Indbakke\n\nSkrevet i toget.\n");
    const fresh = await backend.createFile(ROOT, "Tognote");
    await backend.writeFile(fresh, "Uden net.\n");
    const before = remote.head();

    remote.setOffline(true);
    const res = await backend.gitSync(ROOT);
    expect(res.status).toBe("offline");
    expect(res.committed).toBe(0);
    expect(remote.head()).toBe(before);
    expect(await backend.readFile(path)).toBe("# Indbakke\n\nSkrevet i toget.\n");
    expect((await backend.listFolder(ROOT)).files.map((f) => f.name)).toContain("Tognote");
    expect(await pendingChangesCount(store)).toBe(2);

    remote.setOffline(false);
    expect(await backend.gitSync(ROOT)).toMatchObject({ status: "ok", committed: 2 });
    expect(remote.files()["Indbakke.md"]).toBe("# Indbakke\n\nSkrevet i toget.\n");
    expect(remote.files()["Tognote.md"]).toBe("Uden net.\n");
    expect(await pendingChangesCount(store)).toBe(0);
  });
});

describe("dovne noter (content null)", () => {
  it("readFile henter teksten via sha og gemmer den", async () => {
    const remote = createFakeRemote({ "A.md": "# A\n" });
    const store: LocalStore = createMemoryStore();
    const sha = (await remote.api.getTree((await remote.api.getHead(null))!.head.treeSha))[0].sha;
    await store.update("A.md", () => ({ path: "A.md", sha, base: null, content: null, deleted: false, mtime: 1 }));
    const backend = createGitHubBackend({ store, createApi: () => remote.api, loadConfig: () => CFG });
    expect(await backend.readFile(abs("A.md"))).toBe("# A\n");
    expect(await store.get("A.md")).toMatchObject({ base: "# A\n", content: "# A\n" });
    remote.setOffline(true);
    await store.update("A.md", (cur) => ({ ...cur!, base: null, content: null }));
    await expect(backend.readFile(abs("A.md"))).rejects.toThrow("ingen forbindelse");
  });
});

describe("billeder, links og AI", () => {
  it("openUrl åbner kun http, https og mailto", async () => {
    const { backend } = setup();
    for (const ok of ["https://example.com/a?b=1", "http://example.com", "mailto:rikke@example.com"]) {
      await backend.openUrl(ok);
    }
    expect(openSpy.mock.calls).toEqual([
      ["https://example.com/a?b=1", "_blank", "noopener"],
      ["http://example.com", "_blank", "noopener"],
      ["mailto:rikke@example.com", "_blank", "noopener"],
    ]);
    openSpy.mockClear();
    const bad = [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
      "mdwriter://open",
      "relativ/sti",
      "",
    ];
    for (const url of bad) await backend.openUrl(url);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("saveImage og AI findes kun på computeren", async () => {
    const { backend } = await connected();
    await expect(backend.saveImage(ROOT, "x.png", "AAAA")).rejects.toThrow(
      "Billeder kan kun indsættes på computeren"
    );
    expect(await backend.aiKeyPresent()).toBe(false);
    await expect(backend.aiSetKey("k")).rejects.toThrow("AI-forslag findes kun på computeren");
    await expect(backend.suggestCompletion("t", "p", "s", "m")).rejects.toThrow("AI-forslag findes kun på computeren");
    expect(await backend.pickFolder()).toBeNull();
    expect(await backend.frontendReady()).toEqual([]);
  });

  it("billeder på web: vaultens og nettets giver hver sin pladsholder; indsatte gemmes ikke", async () => {
    vi.stubEnv("MODE", "web");
    vi.resetModules();
    const backendMod = await import("../backend");
    expect(backendMod.platform).toBe("web");
    const placeholder = backendMod.resolveAsset("/notes/Billeder/kat.png");
    expect(placeholder.startsWith("data:image/svg+xml")).toBe(true);
    expect(decodeURIComponent(placeholder)).toContain("Billede kun på computeren");
    expect(backendMod.resolveAsset("/notes/Arbejde/./diagram.png")).toBe(placeholder);

    const images = await import("../images");
    // CSP'en tillader ikke billeder fra nettet: pladsholder i stedet for et brudt billede
    for (const url of ["https://example.com/a.png", "HTTP://example.com/a.png"]) {
      const shown = images.resolveImageSrc(url);
      expect(shown.startsWith("data:image/svg+xml")).toBe(true);
      expect(decodeURIComponent(shown)).toContain("Billede fra nettet vises ikke på telefonen");
    }
    // data: og blob: må CSP'en gerne vise
    for (const url of ["data:image/png;base64,AAAA", "blob:https://x/y"]) {
      expect(images.resolveImageSrc(url)).toBe(url);
    }
    expect(decodeURIComponent(images.resolveImageSrc("/notes/Billeder/kat.png"))).toContain(
      "Billede kun på computeren"
    );
    expect(await images.saveClipboardImage(new File(["x"], "x.png", { type: "image/png" }))).toBeNull();
  });
});

describe("billeder uden for web", () => {
  it("billeder fra nettet vises som før", async () => {
    vi.resetModules();
    const images = await import("../images");
    expect(images.resolveImageSrc("https://example.com/a.png")).toBe("https://example.com/a.png");
  });
});

describe("glem telefonens data", () => {
  it("sletter databasen, forbindelsen og sessionen", async () => {
    vi.resetModules();
    const mod = await import("./githubBackend");
    const remote = createFakeRemote({ "A.md": "# A\n" });
    const backend = mod.createGitHubBackend({ createApi: () => remote.api, loadConfig: () => CFG });
    expect((await backend.gitSync(ROOT)).status).toBe("ok");
    await backend.writeFile(abs("A.md"), "# A ændret\n");
    expect(await mod.pendingChangesCount()).toBe(1);

    localStorage.setItem("mw.web.github", JSON.stringify(CFG));
    localStorage.setItem("mw.folder", ROOT);
    localStorage.setItem("mw.web.dirs", "[]");
    localStorage.setItem("andet", "bliver");
    sessionStorage.setItem("mw.mobileEditor", "1");

    await mod.resetWebData();
    expect(localStorage.getItem("andet")).toBe("bliver");
    expect(localStorage.length).toBe(1);
    expect(sessionStorage.length).toBe(0);
    expect(await openIdbStore().all()).toEqual([]);
    expect(await mod.pendingChangesCount()).toBe(0);
    // intet må genskabe databasen, før siden er genindlæst
    await expect(backend.writeFile(abs("A.md"), "igen")).rejects.toThrow("glemt");
    expect((await backend.gitSync(ROOT)).status).toBe("error");
  });
});
