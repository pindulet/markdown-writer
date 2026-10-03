import { describe, expect, it } from "vitest";
import { cleanName, cleanNoteName, uniqueName, UNTITLED } from "./names";
import { pathKey } from "./syncEngine";

const bytes = (s: string) => new TextEncoder().encode(s).length;

describe("cleanName", () => {
  it("erstatter tegn, der ikke må stå i et filnavn, med -", () => {
    expect(cleanName("Møde/plan")).toBe("Møde-plan");
    expect(cleanName('a\\b:c*d?e"f<g>h|i')).toBe("a-b-c-d-e-f-g-h-i");
  });

  it("fjerner punktummer foran og mellemrum/punktummer bagved", () => {
    expect(cleanName(".skjult")).toBe("skjult");
    expect(cleanName("... . skjult")).toBe("skjult");
    expect(cleanName("Slut. . ")).toBe("Slut");
    expect(cleanName("  Luft  ")).toBe("Luft");
    expect(cleanName("v1.2 udkast")).toBe("v1.2 udkast");
  });

  it("tomt navn bliver til Uden titel", () => {
    expect(cleanName("")).toBe(UNTITLED);
    expect(cleanName("   ")).toBe(UNTITLED);
    expect(cleanName("...")).toBe(UNTITLED);
    expect(UNTITLED).toBe("Uden titel");
  });

  it("bevarer æøå og gemmer nye navne som NFC", () => {
    expect(cleanName("Æbler, øl og ål")).toBe("Æbler, øl og ål");
    const nfd = "Påske".normalize("NFD");
    expect(cleanName(nfd)).toBe("Påske".normalize("NFC"));
  });

  it("fjerner linjeskift og andre kontroltegn", () => {
    expect(cleanName("To\nlinjer\tmed\u0000tegn")).toBe("To linjer med tegn");
  });

  it("afkorter meget lange navne uden at klippe et tegn over", () => {
    const long = "å".repeat(300);
    const out = cleanName(long);
    expect(bytes(out.normalize("NFD"))).toBeLessThanOrEqual(200);
    expect(out.length).toBeGreaterThan(50);
    expect([...out].every((ch) => ch === "å")).toBe(true);
    const emoji = "📝".repeat(100);
    expect([...cleanName(emoji)].every((ch) => ch === "📝")).toBe(true);
  });
});

describe("cleanNoteName", () => {
  it("dropper en .md, brugeren selv har skrevet", () => {
    expect(cleanNoteName("Note.md")).toBe("Note");
    expect(cleanNoteName("Note.MD ")).toBe("Note");
    expect(cleanNoteName("Note.markdown")).toBe("Note.markdown");
    expect(cleanNoteName(".md")).toBe(UNTITLED);
  });
});

describe("uniqueName", () => {
  it("Navn, Navn 2, Navn 3 … som desktop", () => {
    const taken = new Set<string>();
    const next = () => {
      const n = uniqueName("Navn", (c) => taken.has(c));
      taken.add(n);
      return n;
    };
    expect([next(), next(), next()]).toEqual(["Navn", "Navn 2", "Navn 3"]);
  });

  it("sammenligner uden hensyn til store/små bogstaver og NFC/NFD", () => {
    const taken = new Set(["Påske".normalize("NFD"), "påske 2"].map(pathKey));
    expect(uniqueName("PÅSKE", (c) => taken.has(pathKey(c)))).toBe("PÅSKE 3");
  });
});
