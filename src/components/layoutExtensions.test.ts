// @vitest-environment jsdom
// Layout-visningens serialisering: det, editoren skriver, skal kunne læses
// ind igen til præcis det samme dokument — også i tabeller, efter hårde
// linjeskift, i autolinks og i kodeblokke.
import { describe, expect, it } from "vitest";
import { Editor, type JSONContent } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { schemaExtensions } from "./layoutExtensions";
import { getMarkdown } from "../markdownPreserve";

function load(content: string | JSONContent): Editor {
  return new Editor({ extensions: schemaExtensions(), content, injectCSS: false });
}

function serialize(content: string | JSONContent): string {
  const editor = load(content);
  const md = getMarkdown(editor);
  editor.destroy();
  return md;
}

function json(content: string | JSONContent): JSONContent {
  const editor = load(content);
  const doc = editor.getJSON();
  editor.destroy();
  return doc;
}

// parse → serialisér → parse giver samme dokument
function expectRoundTrip(content: string | JSONContent, expected?: JSONContent) {
  const md = serialize(content);
  expect(json(md), md).toEqual(expected ?? json(content));
  return md;
}

const p = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const t = (text: string, marks?: JSONContent["marks"]): JSONContent =>
  marks ? { type: "text", text, marks } : { type: "text", text };
const br: JSONContent = { type: "hardBreak" };
const doc = (...content: JSONContent[]): JSONContent => ({ type: "doc", content });
const cell = (type: "tableCell" | "tableHeader", content: JSONContent[], attrs = {}): JSONContent => ({
  type,
  attrs: { colspan: 1, rowspan: 1, colwidth: null, ...attrs },
  content,
});
const row = (...cells: JSONContent[]): JSONContent => ({ type: "tableRow", content: cells });
const table = (...rows: JSONContent[]): JSONContent => ({ type: "table", content: rows });

// Tabellens celletekster, række for række
function cellTexts(content: string | JSONContent): string[][] {
  const editor = load(content);
  const rows: string[][] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === "tableRow") {
      rows.push([]);
      node.forEach((c) => rows[rows.length - 1].push(c.textContent));
      return false;
    }
  });
  editor.destroy();
  return rows;
}

describe("tabeller", () => {
  it("skriver aldrig [table], heller ikke med flere blokke i en celle", () => {
    const md = serialize(
      doc(
        table(
          row(cell("tableHeader", [p(t("a"))]), cell("tableHeader", [p(t("b"))])),
          row(cell("tableCell", [p(t("linje et")), p(t("linje to"))]), cell("tableCell", [p(t("2"))]))
        )
      )
    );
    expect(md).not.toContain("[table]");
    expect(md).toBe("| a | b |\n| --- | --- |\n| linje et linje to | 2 |\n");
    expect(cellTexts(md)).toEqual([
      ["a", "b"],
      ["linje et linje to", "2"],
    ]);
  });

  it("første række er altid overskrift (fx efter Slet række i overskriften)", () => {
    const md = serialize(
      doc(
        table(
          row(cell("tableCell", [p(t("1"))]), cell("tableCell", [p(t("2"))])),
          row(cell("tableHeader", [p(t("3"))]), cell("tableCell", [p(t("4"))]))
        )
      )
    );
    expect(md).toBe("| 1 | 2 |\n| --- | --- |\n| 3 | 4 |\n");
  });

  it("billeder i celler skrives inline", () => {
    const md = serialize("| ![a](x.png) | b |\n|---|---|\n| 1 | 2 |\n");
    expect(md).toBe("| ![a](x.png) | b |\n| --- | --- |\n| 1 | 2 |\n");
    const pasted = serialize(
      doc(
        table(
          row(cell("tableHeader", [p(t("a"))]), cell("tableHeader", [p(t("b"))])),
          row(
            cell("tableCell", [p(t("før")), { type: "image", attrs: { src: "Bilag/s k.png", alt: "" } }]),
            cell("tableCell", [p(t("2"))])
          )
        )
      )
    );
    expect(pasted).toBe("| a | b |\n| --- | --- |\n| før ![](Bilag/s k.png) | 2 |\n");
  });

  it("escaper | i alias-wikilinks, inline-kode og tekst", () => {
    const src =
      "| [[Linsesuppe\\|Linsesuppe med citron]] | Vegansk | Kokosmælk |\n" +
      "|---|---|---|\n" +
      "| `a\\|b` | x \\| y | c |\n";
    const md = expectRoundTrip(src);
    expect(md).toBe(
      "| [[Linsesuppe\\|Linsesuppe med citron]] | Vegansk | Kokosmælk |\n" +
        "| --- | --- | --- |\n" +
        "| `a\\|b` | x \\| y | c |\n"
    );
    expect(cellTexts(md)[1]).toEqual(["a|b", "x | y", "c"]);
  });

  it("en bogstavelig backslash før | overlever", () => {
    const content = doc(
      table(
        row(cell("tableHeader", [p(t("a\\|b"))]), cell("tableHeader", [p(t("kode", [{ type: "code" }]))])),
        row(cell("tableCell", [p(t("c\\|d", [{ type: "code" }]))]), cell("tableCell", [p(t("2"))]))
      )
    );
    expectRoundTrip(content);
    expect(cellTexts(serialize(content))).toEqual([
      ["a\\|b", "kode"],
      ["c\\|d", "2"],
    ]);
  });

  it("kolonneantallet er det største i nogen række; korte rækker fyldes ud", () => {
    const md = serialize(
      doc(
        table(
          row(cell("tableHeader", [p(t("a"))])),
          row(cell("tableCell", [p(t("1"))]), cell("tableCell", [p(t("2"))]), cell("tableCell", [p(t("3"))]))
        )
      )
    );
    expect(md).toBe("| a |  |  |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n");
  });

  it("flettede celler (colspan/rowspan) taber ingen tekst", () => {
    const md = serialize(
      doc(
        table(
          row(cell("tableHeader", [p(t("bred"))], { colspan: 2 }), cell("tableHeader", [p(t("c"))])),
          row(cell("tableCell", [p(t("høj"))], { rowspan: 2 }), cell("tableCell", [p(t("1"))]), cell("tableCell", [p(t("2"))])),
          row(cell("tableCell", [p(t("3"))]), cell("tableCell", [p(t("4"))]))
        )
      )
    );
    expect(md).toBe("| bred |  | c |\n| --- | --- | --- |\n| høj | 1 | 2 |\n|  | 3 | 4 |\n");
  });

  it("lister og citater i en celle skrives som tekst på rækkens linje", () => {
    const md = serialize(
      doc(
        table(
          row(cell("tableHeader", [p(t("navn"))]), cell("tableHeader", [p(t("note"))])),
          row(
            cell("tableCell", [p(t("Anna"))]),
            cell("tableCell", [
              { type: "bulletList", content: [{ type: "listItem", content: [p(t("tekst her"))] }] },
              {
                type: "taskList",
                content: [{ type: "taskItem", attrs: { checked: true }, content: [p(t("gjort"))] }],
              },
              { type: "blockquote", content: [p(t("citat"))] },
              { type: "horizontalRule" },
              { type: "heading", attrs: { level: 2 }, content: [t("over")] },
              { type: "codeBlock", attrs: { language: null }, content: [t("x = `1`\ny")] },
            ])
          ),
          row(cell("tableCell", [p(t("Bo"))]), cell("tableCell", [p(t("mere"))]))
        )
      )
    );
    expect(md).toBe(
      "| navn | note |\n| --- | --- |\n| Anna | tekst her gjort citat --- over `` x = `1` y `` |\n| Bo | mere |\n"
    );
    expect(cellTexts(md)[1]).toEqual(["Anna", "tekst her gjort citat --- over x = `1` y"]);
  });

  it("hårde linjeskift i en celle bliver til mellemrum, uden escape bagefter", () => {
    const md = serialize(
      doc(
        table(
          row(cell("tableHeader", [p(t("a"))])),
          row(cell("tableCell", [p(t("x"), br, t("- y"), br, br, t("1. z"))]))
        )
      )
    );
    expect(md).toBe("| a |\n| --- |\n| x - y  1. z |\n");
  });

  it("formatering i celler bevares, også først i cellen", () => {
    expectRoundTrip("| **fed** og *kursiv* | `kode` og [link](https://x.dk) |\n|---|---|\n| ~~slettet~~ | [[Note]] |\n");
    // mellemrum inden for fed flyttes ud, som i resten af noten
    const md = serialize(
      doc(
        table(
          row(cell("tableHeader", [p(t("fed ", [{ type: "bold" }]), t("tekst"))])),
          row(cell("tableCell", [p(t("a "), t("b ", [{ type: "italic" }]), t("c"))]))
        )
      )
    );
    expect(md).toBe("| **fed** tekst |\n| --- |\n| a *b* c |\n");
  });

  it("et billede sat ind midt i en celle (skærmbillede på desktop)", () => {
    const editor = load("| a | b |\n|---|---|\n| før efter | 2 |\n");
    let at = -1;
    editor.state.doc.descendants((node, pos) => {
      if (at < 0 && node.isText && node.text === "før efter") at = pos + 4;
    });
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, at)).replaceSelectionWith(
        editor.schema.nodes.image.create({ src: "Bilag/skærm.png" })
      )
    );
    const md = getMarkdown(editor);
    editor.destroy();
    expect(md).toBe("| a | b |\n| --- | --- |\n| før ![](Bilag/skærm.png) efter | 2 |\n");
  });

  it("en tabel i et citat får citattegn på hver linje", () => {
    expectRoundTrip("> | a | b |\n> |---|---|\n> | 1 | 2 |\n");
  });
});

describe("linjen efter et hårdt linjeskift", () => {
  // indrykkede linjer under en tekstlinje er fortsættelse af afsnittet
  const prefixes = ["- x", "+ x", "* x", "1. x", "1) x", "12) x", "> x", "# x", "## x", "===", "=", "---", "+\tx"];

  for (const prefix of prefixes) {
    it(`bliver ikke til blok: "${prefix}"`, () => {
      const src = `Brugertest af v6\n\t${prefix}\n\tefter`;
      const before = json(src);
      expect(before.content).toHaveLength(1);
      expect(before.content![0].type).toBe("paragraph");
      expectRoundTrip(src);
    });
  }

  it("en tabel kan ikke opstå midt i et afsnit", () => {
    for (const delimiter of ["|---|---|", "--|--", ":-- | --:"]) {
      expectRoundTrip(doc(p(t("a"), br, t("x | y"), br, t(delimiter), br, t("1 | 2"))));
    }
  });

  it("også i listepunkter og citater", () => {
    expectRoundTrip("- Punkt\n  \\- ikke en liste\n  \\# ikke en overskrift\n- næste\n");
    expectRoundTrip("> Citat\n> \\- ikke en liste\n> 1\\. heller ikke\n");
    expectRoundTrip("Møde\n\t- 27. april: noget\n");
  });

  it("indledende mellemrum giver hverken liste eller kode", () => {
    expectRoundTrip(doc(p(t("a"), br, t("  - x"))), doc(p(t("a"), br, t("- x"))));
    expectRoundTrip(doc(p(t("a"), br, t("      kode?"))), doc(p(t("a"), br, t("kode?"))));
  });

  it("almindelig tekst efter linjeskift escapes ikke", () => {
    const src = "**Maria:**\nJa, det er rigtigt.\n-10 grader\n#tag og 1.5 liter\n+45 12 34\n= 5 kr";
    expect(serialize(src)).toBe(src);
  });
});

describe("to hårde linjeskift i træk", () => {
  it("giver ikke en tom linje", () => {
    const md = expectRoundTrip("a\\\n\\\nb\n");
    expect(md).toBe("a\n\\\nb");
    expectRoundTrip(doc(p(t("a"), br, br, br, t("b"))));
  });

  it("holder en liste tæt", () => {
    const md = expectRoundTrip("- a\\\n  \\\n  b\n- c\n");
    expect(md).toBe("- a\n  \\\n  b\n- c");
  });

  it("et linjeskift først i afsnittet bevares", () => {
    expectRoundTrip(doc(p(br, t("b"))));
    expectRoundTrip(doc(p(t("før")), p(br, br, t("b"))));
    expectRoundTrip(
      doc({ type: "bulletList", content: [{ type: "listItem", content: [p(br, t("b"))] }] })
    );
  });
});

describe("autolinks", () => {
  it("escaper ikke adressen", () => {
    const src = "<https://example.com/document/d/1AbC_-xYz/edit?tab=t.0> og <https://x.dk/a_b*c~d>\n";
    const md = expectRoundTrip(src);
    expect(md).toBe(src.trimEnd());
  });

  it("almindelige links escapes stadig", () => {
    expect(serialize("[a_*b](https://x.dk/a_b)\n")).toBe("[a\\_\\*b](https://x.dk/a_b)");
  });
});

describe("kodeblokke", () => {
  it("får et længere hegn end ``` indeni", () => {
    const src = "````md\n```\nkode\n```\n````\n\nefter\n";
    const md = expectRoundTrip(src);
    expect(md).toBe("````md\n```\nkode\n```\n````\n\nefter");
    expectRoundTrip("~~~\n`````\n~~~\n");
  });

  it("almindelige kodeblokke er uændrede", () => {
    expect(serialize("```js\nconst a = `x`;\n```\n")).toBe("```js\nconst a = `x`;\n```");
  });
});

describe("tjekbokse", () => {
  it("har danske etiketter til skærmlæsere", () => {
    const editor = load("- [ ] Mælk\n- [x] Brød\n");
    const boxes = editor.view.dom.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(Array.from(boxes).map((b) => b.ariaLabel)).toEqual(["Ikke afkrydset", "Afkrydset"]);
    // følger med, når punktet afkrydses
    let pos = -1;
    editor.state.doc.descendants((node, at) => {
      if (pos < 0 && node.type.name === "taskItem") pos = at;
    });
    editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { checked: true }));
    expect(boxes[0].ariaLabel).toBe("Afkrydset");
    editor.destroy();
  });
});
