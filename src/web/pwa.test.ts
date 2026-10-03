// Opdateringer og genindlæsning må aldrig ske, mens noget er ugemt.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  saved: true,
  flushCalls: 0,
  options: null as null | {
    onNeedRefresh?: () => void;
    onNeedReload?: () => void;
    onRegisteredSW?: (url: string, reg: unknown) => void;
  },
  updateSW: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
}));

vi.mock("virtual:pwa-register", () => ({
  registerSW: (opts: NonNullable<typeof h.options>) => {
    h.options = opts;
    return h.updateSW;
  },
}));
vi.mock("../backend", () => ({ platform: "web" }));
vi.mock("../store", () => ({
  useStore: {
    getState: () => ({
      flushAll: async () => {
        h.flushCalls++;
        return h.saved;
      },
    }),
  },
}));

type Handler = (e: Event) => void;
let docHandlers: Record<string, Handler[]>;
let winHandlers: Record<string, Handler[]>;
let visibility: "visible" | "hidden";
let reload: ReturnType<typeof vi.fn>;

const on = (map: Record<string, Handler[]>) => (type: string, fn: Handler) => {
  (map[type] ??= []).push(fn);
};
const fire = (map: Record<string, Handler[]>, type: string, e: Event = new Event(type)) =>
  (map[type] ?? []).forEach((fn) => fn(e));
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.resetModules();
  h.saved = true;
  h.flushCalls = 0;
  h.options = null;
  h.updateSW = vi.fn(async () => {});
  docHandlers = {};
  winHandlers = {};
  visibility = "visible";
  reload = vi.fn();
  vi.stubGlobal("document", {
    get visibilityState() {
      return visibility;
    },
    activeElement: null,
    addEventListener: on(docHandlers),
  });
  vi.stubGlobal("window", {
    addEventListener: on(winHandlers),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    setInterval: () => 0,
  });
  vi.stubGlobal("location", { reload });
  const data = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function start() {
  const pwa = await import("./pwa");
  pwa.initPwa();
  return pwa;
}

describe("ny version", () => {
  it("tages ikke i brug, mens noget er ugemt — men når alt er gemt", async () => {
    await start();
    h.saved = false;
    h.options!.onNeedRefresh!();
    await settle();
    expect(h.flushCalls).toBe(1);
    expect(h.updateSW).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();

    // stadig ugemt, da appen lægges væk
    visibility = "hidden";
    fire(docHandlers, "visibilitychange");
    await settle();
    expect(h.updateSW).not.toHaveBeenCalled();

    h.saved = true;
    fire(docHandlers, "visibilitychange");
    await settle();
    expect(h.updateSW).toHaveBeenCalledWith(true);
  });

  it("onNeedReload genindlæser ikke med ugemt tekst", async () => {
    await start();
    h.saved = false;
    h.options!.onNeedReload!();
    await settle();
    expect(reload).not.toHaveBeenCalled();
    h.saved = true;
    visibility = "hidden";
    fire(docHandlers, "visibilitychange");
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("vite:preloadError: genindlæser kun, når alt er gemt; ellers senere", async () => {
    await start();
    h.saved = false;
    const e = new Event("vite:preloadError", { cancelable: true });
    fire(winHandlers, "vite:preloadError", e);
    await settle();
    expect(e.defaultPrevented).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    h.saved = true;
    visibility = "hidden";
    fire(docHandlers, "visibilitychange");
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("prøver selv igen om lidt, hvis gemningen fejlede", async () => {
    vi.useFakeTimers();
    await start();
    h.saved = false;
    h.options!.onNeedReload!();
    await settle();
    expect(reload).not.toHaveBeenCalled();
    h.saved = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("reloadWhenSaved", () => {
  it("genindlæser straks, når alt er gemt", async () => {
    const pwa = await start();
    expect(await pwa.reloadWhenSaved()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("venter, når noget er ugemt", async () => {
    const pwa = await start();
    h.saved = false;
    expect(await pwa.reloadWhenSaved()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    h.saved = true;
    visibility = "hidden";
    fire(docHandlers, "visibilitychange");
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
