import { describe, expect, it } from "vitest";
import { changedBlockIndices, mergeThreeWay, splitBlocks } from "./diff";

describe("splitBlocks", () => {
  it("deler ved tomme linjer og giver linjenumre", () => {
    expect(splitBlocks("# A\n\ntekst\nmere\n\n\nslut\n")).toEqual([
      { text: "# A", startLine: 0, endLine: 0 },
      { text: "tekst\nmere", startLine: 2, endLine: 3 },
      { text: "slut", startLine: 6, endLine: 6 },
    ]);
  });

  it("deler ikke inde i ```- og ~~~-kodeblokke", () => {
    const md = "før\n\n```js\nlet a = 1;\n\n\nlet b = 2;\n```\n\n~~~\nx\n\ny\n~~~\n\nefter\n";
    expect(splitBlocks(md).map((b) => b.text)).toEqual([
      "før",
      "```js\nlet a = 1;\n\n\nlet b = 2;\n```",
      "~~~\nx\n\ny\n~~~",
      "efter",
    ]);
  });

  it("en kortere eller anden slags hegnslinje lukker ikke kodeblokken", () => {
    const md = "````\n```\n\nindeni\n~~~\n````\n\nefter";
    expect(splitBlocks(md).map((b) => b.text)).toEqual(["````\n```\n\nindeni\n~~~\n````", "efter"]);
  });

  it("et hegn uden lukning sluger ikke resten af noten", () => {
    const md = "Intro\n\n```\nkode\n\nP1\n\nP2\n";
    expect(splitBlocks(md).map((b) => b.text)).toEqual(["Intro", "```\nkode", "P1", "P2"]);
  });

  it("fletning med et halvskrevet kodehegn dublerer intet", () => {
    const base = "Intro\n\nP1\n\nP2\n\nP3\n";
    const mine = "Intro\n\n```\nkode\n\nP1\n\nP2\n\nP3\n";
    const theirs = "Intro\n\nP1\n\nP2\n\nP3 ændret\n";
    expect(mergeThreeWay(base, mine, theirs)).toBe("Intro\n\n```\nkode\n\nP1\n\nP2\n\nP3 ændret\n");
  });

  it("CRLF: blokkens tekst slutter ikke med \\r", () => {
    expect(splitBlocks("a\r\nb\r\n\r\nc\r\n").map((b) => b.text)).toEqual(["a\r\nb", "c"]);
  });
});

describe("changedBlockIndices", () => {
  it("en kodeblok med tomme linjer er én blok", () => {
    const prev = "# T\n\n```\nx\n\ny\n```\n";
    const next = "# T\n\n```\nx\n\ny ændret\n```\n";
    expect(changedBlockIndices(prev, next)).toEqual([1]);
  });

  it("CRLF og LF med samme tekst er uændret", () => {
    expect(changedBlockIndices("a\r\nb\r\n\r\nc\r\n", "a\nb\n\nc\n")).toEqual([]);
  });
});

describe("mergeThreeWay", () => {
  const base = "# Møde\n\nAftalt: fredag.\n\nDeltagere: Rikke.\n\nNæste gang: workshop.\n";

  it("ændringer i hver sin blok flettes", () => {
    const mine = base.replace("fredag", "torsdag");
    const theirs = base.replace("workshop.", "workshop og frokost.");
    expect(mergeThreeWay(base, mine, theirs)).toBe(
      "# Møde\n\nAftalt: torsdag.\n\nDeltagere: Rikke.\n\nNæste gang: workshop og frokost.\n"
    );
  });

  it("samme blok ændret begge steder: begge beholdes, min først", () => {
    const mine = base.replace("Rikke", "Rikke og Ask");
    const theirs = base.replace("Rikke", "Rikke og Bo");
    expect(mergeThreeWay(base, mine, theirs)).toBe(
      "# Møde\n\nAftalt: fredag.\n\nDeltagere: Rikke og Ask.\n\nDeltagere: Rikke og Bo.\n\nNæste gang: workshop.\n"
    );
  });

  it("kun én side ændret giver præcis den side", () => {
    const odd = "\n# A\r\n\r\n\r\nB  \r\n\r\nC";
    const changed = "\n# A\r\n\r\n\r\nB ændret  \r\n\r\nC\r\n";
    expect(mergeThreeWay(odd, odd, changed)).toBe(changed);
    expect(mergeThreeWay(odd, changed, odd)).toBe(changed);
    expect(mergeThreeWay(odd, changed, changed)).toBe(changed);
  });

  it("bevarer flere tomme linjer mellem urørte blokke", () => {
    const b = "a\n\n\n\nb\n\n\nc\n";
    expect(mergeThreeWay(b, "a2\n\n\n\nb\n\n\nc\n", "a\n\n\n\nb\n\n\nc2\n")).toBe("a2\n\n\n\nb\n\n\nc2\n");
  });

  it("CRLF-noter forbliver CRLF, også ved nye blokgrænser", () => {
    const b = "# T\r\n\r\nen\r\n\r\nto\r\n";
    const mine = "# T\r\n\r\nen lokal\r\n\r\nto\r\n";
    const theirs = "# T\r\n\r\nen\r\n\r\nto\r\n\r\ntre\r\n";
    const merged = mergeThreeWay(b, mine, theirs);
    expect(merged).toBe("# T\r\n\r\nen lokal\r\n\r\nto\r\n\r\ntre\r\n");
    expect(merged.replace(/\r\n/g, "")).not.toContain("\n");

    // begge ændrer samme blok: den nye grænse mellem de to versioner er også CRLF
    const both = mergeThreeWay(b, mine, "# T\r\n\r\nen fjern\r\n\r\nto\r\n");
    expect(both).toBe("# T\r\n\r\nen lokal\r\n\r\nen fjern\r\n\r\nto\r\n");
  });

  it("splitter ikke kodeblokke med tomme linjer (ingen dubletter, tomme linjer bevares)", () => {
    const b = "# Kode\n\n```\nlinje 1\n\n\nlinje 2\n```\n\nMellem.\n\nSlut.\n";
    const mine = "# Kode\n\n```\nlinje 1\n\n\nlinje 2 rettet\n```\n\nMellem.\n\nSlut.\n";
    const theirs = "# Kode\n\n```\nlinje 1\n\n\nlinje 2\n```\n\nMellem.\n\nSlut og færdig.\n";
    expect(mergeThreeWay(b, mine, theirs)).toBe(
      "# Kode\n\n```\nlinje 1\n\n\nlinje 2 rettet\n```\n\nMellem.\n\nSlut og færdig.\n"
    );
  });

  it("afsluttende linjeskift: ændringen fra den side, der ændrede det, vinder", () => {
    expect(mergeThreeWay("a\n\nb", "a\n\nb", "a\n\nb\n")).toBe("a\n\nb\n");
    expect(mergeThreeWay("a\n\nb\n", "a2\n\nb\n", "a\n\nb\n\nc")).toBe("a2\n\nb\n\nc");
    expect(mergeThreeWay("a\n\nb\n", "a\n\nb\n", "a\n")).toBe("a\n");
  });

  it("nabo-afsnit ændret på hver sin side flettes uden dubletter", () => {
    const b = "# A\n\net\n\n\nto\n";
    expect(mergeThreeWay(b, "# A\n\net lokalt\n\n\nto\n", "# A\n\net\n\n\nto fjernt\n")).toBe(
      "# A\n\net lokalt\n\n\nto fjernt\n"
    );
  });

  it("nyt afsnit sidst på telefonen + rettelse i sidste afsnit på computeren", () => {
    const b = "# Uge 40\n\nMandag: møde.\n";
    const mine = "# Uge 40\n\nMandag: møde.\n\nTirsdag: skrev.\n";
    const theirs = "# Uge 40\n\nMandag: møde med Rikke.\n";
    expect(mergeThreeWay(b, mine, theirs)).toBe("# Uge 40\n\nMandag: møde med Rikke.\n\nTirsdag: skrev.\n");
  });

  it("begge indsætter samme sted: begge beholdes, min først", () => {
    const b = "a\n\nz\n";
    expect(mergeThreeWay(b, "a\n\nmin\n\nz\n", "a\n\nderes\n\nz\n")).toBe("a\n\nmin\n\nderes\n\nz\n");
    expect(mergeThreeWay(b, "a\n\nsamme\n\nz\n", "a\n\nsamme\n\nz\n")).toBe("a\n\nsamme\n\nz\n");
  });

  it("ændret her, slettet der: ændringen bevares", () => {
    const b = "a\n\nb\n\nc\n";
    expect(mergeThreeWay(b, "a\n\nb ændret\n\nc\n", "a\n\nc\n")).toBe("a\n\nb ændret\n\nc\n");
    expect(mergeThreeWay(b, "a\n\nc\n", "a\n\nb ændret\n\nc\n")).toBe("a\n\nb ændret\n\nc\n");
    // slettet begge steder
    expect(mergeThreeWay(b, "a\n\nc\n", "a\n\nc\n")).toBe("a\n\nc\n");
  });

  it("tilfældige redigeringer: kun-én-side giver den side, og intet nyt går tabt", () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    let uid = 0;
    const sep = () => ["\n\n", "\n\n\n", "\n \n"][rnd(3)];
    const join = (blocks: string[]) => blocks.reduce((acc, bl, i) => acc + bl + (i + 1 < blocks.length ? sep() : "\n"), "");
    const edit = (blocks: string[]) => {
      const out = [...blocks];
      for (let n = rnd(4); n > 0; n--) {
        const i = rnd(out.length + 1);
        const op = rnd(3);
        if (op === 0) out.splice(i, 0, `ny ${uid++}`);
        else if (op === 1 && i < out.length) out[i] = `${out[i]} rettet ${uid++}`;
        else if (op === 2 && i < out.length) out.splice(i, 1);
      }
      return out;
    };
    for (let run = 0; run < 400; run++) {
      const baseBlocks = Array.from({ length: 1 + rnd(6) }, (_, i) => `blok ${run}.${i}`);
      const b = join(baseBlocks);
      const m = join(edit(baseBlocks));
      const t = join(edit(baseBlocks));
      expect(mergeThreeWay(b, m, b)).toBe(m);
      expect(mergeThreeWay(b, b, t)).toBe(t);
      expect(mergeThreeWay(b, m, m)).toBe(m);
      const out = splitBlocks(mergeThreeWay(b, m, t)).map((x) => x.text);
      const inBase = new Set(baseBlocks);
      for (const block of [...splitBlocks(m), ...splitBlocks(t)].map((x) => x.text)) {
        if (!inBase.has(block)) expect(out).toContain(block);
      }
      // urørt begge steder → stadig med
      const mSet = new Set(splitBlocks(m).map((x) => x.text));
      const tSet = new Set(splitBlocks(t).map((x) => x.text));
      for (const block of baseBlocks) if (mSet.has(block) && tSet.has(block)) expect(out).toContain(block);
    }
  });

  it("tomme versioner", () => {
    expect(mergeThreeWay("", "", "")).toBe("");
    expect(mergeThreeWay("", "ny\n", "")).toBe("ny\n");
    expect(mergeThreeWay("a\n", "", "a\n")).toBe("");
  });
});
