// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { isMobileNow, sidebarOnLayoutSwitch } from "./useIsMobile";

// jsdom kender ikke medieforespørgsler; en lille evaluator dækker det, appen
// bruger: (max-width|max-height|min-width|min-height: Npx), (pointer: x),
// "and" og komma (= eller)
interface Device {
  width: number;
  height: number;
  pointer: "fine" | "coarse";
}

function matches(query: string, d: Device): boolean {
  return query.split(",").some((part) =>
    part
      .split(/\band\b/)
      .map((f) => f.trim())
      .filter(Boolean)
      .every((feature) => {
        const m = feature.match(/^\(\s*([a-z-]+)\s*:\s*([a-z0-9.]+)\s*\)$/);
        if (!m) throw new Error(`Ukendt medieforespørgsel: ${feature}`);
        const [, name, value] = m;
        const px = parseFloat(value);
        switch (name) {
          case "max-width":
            return d.width <= px;
          case "min-width":
            return d.width >= px;
          case "max-height":
            return d.height <= px;
          case "min-height":
            return d.height >= px;
          case "pointer":
            return d.pointer === value;
          default:
            throw new Error(`Ukendt egenskab: ${name}`);
        }
      })
  );
}

function emulate(d: Device) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: matches(query, d),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// CSS-pixels (layout-viewporten, som medieforespørgsler måler; den skrumper
// ikke, når tastaturet åbner på iOS)
const devices: Array<[string, Device, boolean]> = [
  ["iPhone SE stående", { width: 375, height: 667, pointer: "coarse" }, true],
  ["iPhone SE liggende", { width: 667, height: 375, pointer: "coarse" }, true],
  ["iPhone 16 stående", { width: 393, height: 852, pointer: "coarse" }, true],
  ["iPhone 16 liggende", { width: 852, height: 393, pointer: "coarse" }, true],
  ["iPhone 17 Pro Max liggende", { width: 956, height: 440, pointer: "coarse" }, true],
  ["iPhone X liggende", { width: 812, height: 375, pointer: "coarse" }, true],
  ["iPad Air stående", { width: 820, height: 1180, pointer: "coarse" }, false],
  ["iPad Air liggende", { width: 1180, height: 820, pointer: "coarse" }, false],
  ["iPad mini liggende", { width: 1133, height: 744, pointer: "coarse" }, false],
  ["iPad Split View (smal)", { width: 320, height: 1180, pointer: "coarse" }, true],
  ["Mac, normalt vindue", { width: 1440, height: 900, pointer: "fine" }, false],
  ["Mac, lavt vindue", { width: 900, height: 420, pointer: "fine" }, false],
  ["Mac, smalt browservindue", { width: 600, height: 800, pointer: "fine" }, true],
];

describe("useIsMobile: mobillayout", () => {
  it.each(devices)("%s", (_name, device, expected) => {
    emulate(device);
    expect(isMobileNow()).toBe(expected);
  });
});

describe("sidebarOnLayoutSwitch", () => {
  it("viser kolonnen, når en åben mobilnote kommer til desktop, og åbner noten igen ved skift tilbage", () => {
    const memo = { reopenNote: false };
    // mobil med noten åben = sidebarVisible false
    expect(sidebarOnLayoutSwitch(false, { sidebarVisible: false, hasNote: true }, memo)).toBe(true);
    // tilbage til mobil: brugeren skal lande i noten, ikke i listen
    expect(sidebarOnLayoutSwitch(true, { sidebarVisible: true, hasNote: true }, memo)).toBe(false);
  });

  it("lader listen være, når den allerede blev vist på mobil", () => {
    const memo = { reopenNote: false };
    expect(sidebarOnLayoutSwitch(false, { sidebarVisible: true, hasNote: true }, memo)).toBeNull();
    expect(sidebarOnLayoutSwitch(true, { sidebarVisible: true, hasNote: true }, memo)).toBeNull();
  });

  it("åbner ikke en note, der er lukket imens på desktop", () => {
    const memo = { reopenNote: false };
    expect(sidebarOnLayoutSwitch(false, { sidebarVisible: false, hasNote: true }, memo)).toBe(true);
    expect(sidebarOnLayoutSwitch(true, { sidebarVisible: true, hasNote: false }, memo)).toBeNull();
    // og huskes ikke til et senere skift
    expect(sidebarOnLayoutSwitch(false, { sidebarVisible: true, hasNote: true }, memo)).toBeNull();
    expect(sidebarOnLayoutSwitch(true, { sidebarVisible: true, hasNote: true }, memo)).toBeNull();
  });

  it("viser kolonnen uden at huske noget, når der ingen note var åben", () => {
    const memo = { reopenNote: false };
    expect(sidebarOnLayoutSwitch(false, { sidebarVisible: false, hasNote: false }, memo)).toBe(true);
    expect(sidebarOnLayoutSwitch(true, { sidebarVisible: true, hasNote: true }, memo)).toBeNull();
  });

  it("rører ikke en kolonne, brugeren selv har skjult på desktop", () => {
    const memo = { reopenNote: false };
    expect(sidebarOnLayoutSwitch(false, { sidebarVisible: false, hasNote: true }, memo)).toBe(true);
    // brugeren skjuler kolonnen igen (⌘\): mobil viser noten af sig selv
    expect(sidebarOnLayoutSwitch(true, { sidebarVisible: false, hasNote: true }, memo)).toBeNull();
  });
});
