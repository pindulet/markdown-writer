// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

// lille store uden notice-feltet; testen sætter det selv, hvor det skal
// bruges (komponenten må ikke fejle, hvis feltet mangler)
vi.mock("../store", async () => {
  const { create } = await import("zustand");
  const useStore = create<Record<string, unknown>>(() => ({ folder: "/noter" }));
  return { useStore };
});

import Notice, { NOTICE_FALLBACK_MS } from "./Notice";
import { useStore } from "../store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const store = useStore as unknown as {
  setState: (p: Record<string, unknown>) => void;
  getState: () => Record<string, unknown>;
};
const setStore = (patch: Record<string, unknown>) => store.setState(patch);
const notice = () => store.getState().notice;

let root: Root;
let host: HTMLElement;

function region(): HTMLElement {
  return host.querySelector<HTMLElement>("[aria-live]")!;
}

function toast(): HTMLElement | null {
  return host.querySelector<HTMLElement>(".notice");
}

function render(props: { above?: string } = {}) {
  act(() => root.render(createElement(Notice, props)));
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "";
  host = document.createElement("div");
  host.className = "app";
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  setStore({ notice: undefined });
  vi.useRealTimers();
});

describe("Notice", () => {
  it("fungerer, selv om store endnu ikke har feltet notice", () => {
    render();
    expect(region()).not.toBeNull();
    expect(region().getAttribute("aria-live")).toBe("polite");
    expect(region().textContent).toBe("");
    expect(toast()).toBeNull();
  });

  it("viser beskeden i en live-region, der fandtes i forvejen (så skærmlæsere læser den op)", () => {
    render();
    const live = region();
    act(() => setStore({ notice: "Noten er gemt som kopi" }));
    expect(region()).toBe(live);
    expect(toast()?.textContent).toBe("Noten er gemt som kopi");
  });

  it("toner ud og forsvinder, når store rydder beskeden", () => {
    render();
    act(() => setStore({ notice: "Synkroniseret" }));
    act(() => setStore({ notice: null }));
    // står et øjeblik, mens den toner ud
    expect(toast()?.textContent).toBe("Synkroniseret");
    expect(toast()?.classList.contains("leaving")).toBe(true);
    act(() => vi.advanceTimersByTime(300));
    expect(toast()).toBeNull();
    expect(region().textContent).toBe("");
  });

  it("en ny besked erstatter den gamle, også mens den gamle toner ud", () => {
    render();
    act(() => setStore({ notice: "Første" }));
    act(() => setStore({ notice: "Anden besked" }));
    expect(toast()?.textContent).toBe("Anden besked");
    act(() => setStore({ notice: null }));
    act(() => vi.advanceTimersByTime(50));
    act(() => setStore({ notice: "Tredje" }));
    act(() => vi.advanceTimersByTime(500));
    expect(toast()?.textContent).toBe("Tredje");
    expect(toast()?.classList.contains("leaving")).toBe(false);
  });

  it("skjules efter et sikkerhedsnet, hvis store aldrig rydder den, uden selv at ændre store", () => {
    render();
    act(() => setStore({ notice: "Hænger" }));
    act(() => vi.advanceTimersByTime(NOTICE_FALLBACK_MS - 100));
    expect(toast()).not.toBeNull();
    act(() => vi.advanceTimersByTime(400));
    expect(toast()).toBeNull();
    expect(notice()).toBe("Hænger");
  });

  it("lægger sig over bundlinjen, den skal holde fri af (fx notelistens fod)", () => {
    const footer = document.createElement("div");
    footer.className = "sidebar-footer";
    Object.defineProperty(footer, "offsetHeight", { value: 118 });
    host.appendChild(footer);
    const inner = document.createElement("div");
    host.appendChild(inner);
    root = createRoot(inner);
    render({ above: ".sidebar-footer" });
    act(() => setStore({ notice: "Hej" }));
    expect(toast()?.style.marginBottom).toBe("128px");
  });
});
