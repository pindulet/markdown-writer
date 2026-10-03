// @vitest-environment jsdom
// Den rigtige store oven på web-backenden (GitHub + telefonens lager i
// hukommelsen) og et falsk GitHub. Platformen kan skiftes pr. test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "./backend";
import { createFakeRemote, type FakeRemote } from "./web/fakeRemote";
import { createGitHubBackend } from "./web/githubBackend";
import { createMemoryStore } from "./web/localStore";
import type { GitHubConfig, LocalStore } from "./web/types";

const h = vi.hoisted(() => ({
  backend: null as unknown as Backend,
  platform: "web" as "web" | "desktop" | "mock",
}));

vi.mock("./backend", () => {
  const names = [
    "listFolder",
    "readFile",
    "writeFile",
    "createFile",
    "createFolder",
    "saveImage",
    "renameFile",
    "deleteFile",
    "watchFolder",
    "gitInfo",
    "gitSync",
    "pickFolder",
    "openUrl",
    "onFsChange",
    "onOpenFile",
    "onSyncProgress",
    "frontendReady",
    "aiKeyPresent",
    "aiSetKey",
    "suggestCompletion",
  ] as const;
  const mod: Record<string, unknown> = {
    get platform() {
      return h.platform;
    },
    resolveAsset: (p: string) => p,
  };
  for (const name of names) {
    mod[name] = (...args: unknown[]) => (h.backend[name] as (...a: unknown[]) => unknown)(...args);
  }
  return mod;
});

type StoreHook = typeof import("./store").useStore;
let useStore: StoreHook;

const CFG: GitHubConfig = { owner: "pindulet", repo: "notes", branch: "main", token: "test", connectedAt: 0 };
const ROOT = "/notes";
const A = `${ROOT}/A.md`;
const A_V0 = "# A\n\nAfsnit et.\n\nAfsnit to.\n";

let remote: FakeRemote;
let local: LocalStore;
let unlisten: () => void;

async function setup(files: Record<string, string> = { "A.md": A_V0 }) {
  remote = createFakeRemote(files);
  local = createMemoryStore();
  h.backend = createGitHubBackend({ store: local, createApi: () => remote.api, loadConfig: () => CFG });
  // som App.tsx
  unlisten = h.backend.onFsChange((paths) => void useStore.getState().handleFsChange(paths));
  await useStore.getState().setFolder(ROOT);
  await vi.waitFor(() => expect(useStore.getState().syncStatus).toBe("ok"));
  await useStore.getState().refreshFiles(); // ellers først 300 ms efter synken
}

const doc = (path = A) => useStore.getState().docs[path];

// ny store pr. test, så modulets egne registre (lastWritten, synk-lås) ikke lækker
beforeEach(async () => {
  h.platform = "web";
  localStorage.clear();
  vi.resetModules();
  useStore = (await import("./store")).useStore;
});

afterEach(() => {
  unlisten?.();
});

describe("ekstern ændring mens noten er ugemt (web)", () => {
  it("flettes automatisk; intet tabes, heller ikke det, der skrives bagefter", async () => {
    await setup();
    await useStore.getState().openFile(A);
    // telefonen skriver (ugemt, inden for de 800 ms) …
    useStore.getState().editContent(A, "# A\n\nAfsnit et – fra telefonen.\n\nAfsnit to.\n");
    // … imens ændrer computeren et andet afsnit, og synken henter det
    remote.commitFromDesktop({ "A.md": "# A\n\nAfsnit et.\n\nAfsnit to – fra computeren.\n" });
    await useStore.getState().syncNow();
    const merged = "# A\n\nAfsnit et – fra telefonen.\n\nAfsnit to – fra computeren.\n";
    await vi.waitFor(() => expect(doc().content).toBe(merged));
    expect(doc().conflict).toBeNull();
    expect(doc().dirty).toBe(false);
    expect(doc().showExternalBanner).toBe(true);
    expect(doc().prevContent).toBe("# A\n\nAfsnit et – fra telefonen.\n\nAfsnit to.\n");
    expect((await local.get("A.md"))?.content).toBe(merged);

    // der skrives videre, og appen lægges væk (flushAll + synk)
    const more = `${merged}\nNyt afsnit.\n`;
    useStore.getState().editContent(A, more);
    expect(await useStore.getState().flushAll()).toBe(true);
    expect((await local.get("A.md"))?.content).toBe(more);
    await useStore.getState().syncNow();
    expect(remote.files()["A.md"]).toBe(more);
  });

  it("Fortryd giver brugerens egen version tilbage og gemmer den", async () => {
    await setup();
    await useStore.getState().openFile(A);
    const mine = "# A\n\nAfsnit et – fra telefonen.\n\nAfsnit to.\n";
    useStore.getState().editContent(A, mine);
    remote.commitFromDesktop({ "A.md": "# A\n\nAfsnit et.\n\nAfsnit to – fra computeren.\n" });
    await useStore.getState().syncNow();
    await vi.waitFor(() => expect(doc().showExternalBanner).toBe(true));
    await useStore.getState().undoExternal(A);
    expect(doc().content).toBe(mine);
    expect((await local.get("A.md"))?.content).toBe(mine);
  });

  it("Fortryd efter videre skrivning fjerner kun computerens ændring", async () => {
    await setup();
    await useStore.getState().openFile(A);
    useStore.getState().editContent(A, "# A\n\nAfsnit et – fra telefonen.\n\nAfsnit to.\n");
    remote.commitFromDesktop({ "A.md": "# A\n\nAfsnit et.\n\nAfsnit to – fra computeren.\n" });
    await useStore.getState().syncNow();
    await vi.waitFor(() => expect(doc().showExternalBanner).toBe(true));
    // der skrives videre, mens banneret står der
    const typed = "# A\n\nAfsnit et – fra telefonen.\n\nAfsnit to – fra computeren.\n\nVigtig ny sætning.\n";
    useStore.getState().editContent(A, typed);
    await useStore.getState().undoExternal(A);
    const expected = "# A\n\nAfsnit et – fra telefonen.\n\nAfsnit to.\n\nVigtig ny sætning.\n";
    expect(doc().content).toBe(expected);
    expect((await local.get("A.md"))?.content).toBe(expected);
  });

  it("desktop beholder konfliktbanneret", async () => {
    h.platform = "desktop";
    await setup();
    await useStore.getState().openFile(A);
    useStore.getState().editContent(A, "# A\n\nAfsnit et – lokalt.\n\nAfsnit to.\n");
    remote.commitFromDesktop({ "A.md": "# A\n\nAfsnit et.\n\nAfsnit to – fjernt.\n" });
    await useStore.getState().syncNow();
    await vi.waitFor(() => expect(doc().conflict).toBe("# A\n\nAfsnit et.\n\nAfsnit to – fjernt.\n"));
    expect(doc().content).toBe("# A\n\nAfsnit et – lokalt.\n\nAfsnit to.\n");
    expect(doc().dirty).toBe(true);
    // og flushAll melder, at noget ikke er gemt
    expect(await useStore.getState().flushAll()).toBe(false);
  });
});

describe("flushAll", () => {
  it("sand, når alt er gemt; falsk, når en skrivning fejler", async () => {
    await setup();
    await useStore.getState().openFile(A);
    useStore.getState().editContent(A, "# A\n\nændret\n");
    expect(await useStore.getState().flushAll()).toBe(true);
    expect((await local.get("A.md"))?.content).toBe("# A\n\nændret\n");

    const original = h.backend.writeFile;
    h.backend.writeFile = async () => {
      throw new Error("QuotaExceededError");
    };
    useStore.getState().editContent(A, "# A\n\nændret igen\n");
    expect(await useStore.getState().flushAll()).toBe(false);
    expect(doc().dirty).toBe(true);
    h.backend.writeFile = original;
    expect(await useStore.getState().flushAll()).toBe(true);
  });
});

describe("synk i kø (web)", () => {
  it("køet synk kører straks efter den kørende, ikke først efter debounce", async () => {
    await setup();
    await useStore.getState().openFile(A);
    let first: Promise<void> | null = null;
    remote.hooks.beforeCommit = async (attempt) => {
      if (attempt !== 1) return;
      // synken er i gang med at sende: brugeren afkrydser noget og lægger appen væk
      useStore.getState().editContent(A, "# A\n\nAfsnit et.\n\nAfsnit to.\n\n- [x] gjort\n");
      await useStore.getState().flushAll();
      await useStore.getState().syncNow(); // køes, da en synk kører
    };
    useStore.getState().editContent(A, "# A\n\nAfsnit et – ændret.\n\nAfsnit to.\n");
    await useStore.getState().flushAll();
    first = useStore.getState().syncNow();
    await first;
    await vi.waitFor(() => expect(remote.files()["A.md"]).toContain("- [x] gjort"), { timeout: 2000 });
  });
});

describe("wikilinks", () => {
  const files = {
    "A.md": A_V0,
    [`Privat/${"Påske".normalize("NFD")}.md`]: "# Påske\n",
    "Opskrifter/Linsesuppe.md": "# Linsesuppe\n",
    "Tech/Node.js.md": "# Node\n",
  };

  it("NFC-link finder NFD-note, uden at der oprettes noget", async () => {
    await setup(files);
    await useStore.getState().openWikilink("påske");
    expect(useStore.getState().activePath).toBe(`${ROOT}/Privat/${"Påske".normalize("NFD")}.md`);
    expect(Object.keys(remote.files()).length).toBe(4);
    expect((await local.all()).length).toBe(4);
  });

  it("escaped lodret streg og afsluttende backslash fra tabeller", async () => {
    await setup(files);
    await useStore.getState().openWikilink("Linsesuppe\\|60 kuverter");
    expect(useStore.getState().activePath).toBe(`${ROOT}/Opskrifter/Linsesuppe.md`);
    useStore.setState({ activePath: null });
    await useStore.getState().openWikilink("Linsesuppe\\");
    expect(useStore.getState().activePath).toBe(`${ROOT}/Opskrifter/Linsesuppe.md`);
    expect((await local.all()).length).toBe(4);
  });

  it("bilag og billeder opretter aldrig en note, men giver en besked", async () => {
    await setup(files);
    for (const target of ["foto.png", "bilag.pdf", "Mappe/rapport.docx", "Bilag.PDF|alias"]) {
      await useStore.getState().openWikilink(target);
    }
    expect(useStore.getState().activePath).toBeNull();
    expect((await local.all()).length).toBe(4);
    expect(useStore.getState().notice).toBe("Bilag kan kun åbnes på computeren");
  });

  it("på desktop lyder beskeden anderledes", async () => {
    h.platform = "desktop";
    await setup(files);
    await useStore.getState().openWikilink("foto.png");
    expect(useStore.getState().notice).toBe("Bilaget findes ikke som note");
    expect((await local.all()).length).toBe(4);
  });

  it("noter med punktum i navnet og [[Note.md]] åbnes stadig; ukendt note oprettes", async () => {
    await setup(files);
    await useStore.getState().openWikilink("Node.js");
    expect(useStore.getState().activePath).toBe(`${ROOT}/Tech/Node.js.md`);
    await useStore.getState().openWikilink("A.md");
    expect(useStore.getState().activePath).toBe(A);
    await useStore.getState().openWikilink("Opskrifter/Linsesuppe");
    expect(useStore.getState().activePath).toBe(`${ROOT}/Opskrifter/Linsesuppe.md`);
    await useStore.getState().openWikilink("Ny idé");
    expect(useStore.getState().activePath).toBe(`${ROOT}/Ny idé.md`);
  });
});

describe("besked (notice)", () => {
  it("forsvinder af sig selv efter ca. 4 sekunder", () => {
    vi.useFakeTimers();
    try {
      useStore.getState().showNotice("Hej");
      expect(useStore.getState().notice).toBe("Hej");
      vi.advanceTimersByTime(3000);
      useStore.getState().showNotice("Igen");
      vi.advanceTimersByTime(3000);
      expect(useStore.getState().notice).toBe("Igen");
      vi.advanceTimersByTime(1500);
      expect(useStore.getState().notice).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("tekststørrelse", () => {
  it("web: aldrig under 100 %, heller ikke fra en gemt værdi", async () => {
    useStore.getState().setZoom(0.8);
    expect(useStore.getState().zoom).toBe(1);
    useStore.getState().setZoom(1.3);
    expect(useStore.getState().zoom).toBe(1.3);
    localStorage.setItem("mw.zoom", "0.7");
    h.backend = createGitHubBackend({ store: createMemoryStore(), createApi: () => createFakeRemote().api, loadConfig: () => CFG });
    await useStore.getState().init();
    expect(useStore.getState().zoom).toBe(1);
  });

  it("desktop: ned til 70 %", () => {
    h.platform = "desktop";
    useStore.getState().setZoom(0.7);
    expect(useStore.getState().zoom).toBe(0.7);
  });
});
