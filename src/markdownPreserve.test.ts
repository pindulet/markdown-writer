// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { schemaExtensions } from "./components/layoutExtensions";
import {
  createPreserver,
  getMarkdown,
  joinFrontmatter,
  normalizeMarkdown,
  preserveMarkdown,
  splitFrontmatter,
  unescapeWikilinks,
} from "./markdownPreserve";

// Indlæser en note som LayoutEditor: frontmatter udenom, kroppen i editoren
function open(src: string) {
  const { frontmatter, body } = splitFrontmatter(src);
  const editor = new Editor({ extensions: schemaExtensions(), content: body, injectCSS: false });
  const preserver = createPreserver(body, getMarkdown(editor));
  return {
    editor,
    save: () => joinFrontmatter(frontmatter, preserver.apply(getMarkdown(editor))),
  };
}

function textRange(editor: Editor, needle: string): { from: number; to: number } {
  let found: { from: number; to: number } | null = null;
  editor.state.doc.descendants((node: PMNode, pos: number) => {
    if (found || !node.isText || !node.text?.includes(needle)) return;
    const i = node.text.indexOf(needle);
    found = { from: pos + i, to: pos + i + needle.length };
  });
  if (!found) throw new Error(`fandt ikke "${needle}"`);
  return found;
}

// som når man skriver: erstat en tekst i dokumentet
function replace(editor: Editor, needle: string, text: string) {
  const { from, to } = textRange(editor, needle);
  editor.commands.command(({ tr }) => {
    tr.insertText(text, from, to);
    return true;
  });
}

// slet den topniveau-blok, der indeholder teksten
function deleteBlock(editor: Editor, needle: string) {
  const { from } = textRange(editor, needle);
  const $pos = editor.state.doc.resolve(from);
  editor.commands.command(({ tr }) => {
    tr.delete($pos.before(1), $pos.after(1));
    return true;
  });
}

// indsæt et nyt afsnit efter den topniveau-blok, der indeholder teksten
function insertParagraphAfter(editor: Editor, needle: string, text: string) {
  const { from } = textRange(editor, needle);
  const after = editor.state.doc.resolve(from).after(1);
  editor.commands.command(({ tr, state }) => {
    tr.insert(after, state.schema.nodes.paragraph.create(null, state.schema.text(text)));
    return true;
  });
}

// Noter skrevet i hånden (Obsidian, Claude, telefonen) — alt det, som
// editorens serializer ellers skriver om
const SAMPLES: Record<string, string> = {
  "bløde linjeskift": "Linje a\nLinje b\nLinje c\n",
  "*-liste": "* en\n* to\n  * under\n* tre\n",
  "+-liste": "+ en\n+ to\n",
  "nummereret liste": "1. a\n1. b\n1. c\n",
  "nummereret med parentes": "1) a\n2) b\n",
  "løs liste": "- a\n\n- b\n\n  fortsat afsnit\n\n- c\n",
  "liste med tabulator": "* a\n\t* b\n\t\t* c\n",
  tabel: "| a | b |\n|---|---|\n| 1 | 2 |\n|3|4|\n",
  tjekliste: "- [ ] a\n- [x] b\n* [X] c\n",
  citat: "> citat over\n> to linjer\n",
  callout: "> [!fakta] Titel\n> tekst\n> mere tekst\n",
  wikilinks: "Se [[Note]] og [[Mappe/Note|alias]] og ![[billede.png]]\n",
  frontmatter: "---\ntags: [a, b]\ntitle: Noget\n---\n# Overskrift\n\ntekst\n",
  CRLF: "# T\r\n\r\nLinje a\r\nLinje b\r\n\r\n* x\r\n* y\r\n",
  "ingen afsluttende linjeskift": "# T\n\ntekst",
  "flere tomme linjer": "a\n\n\n\nb\n\n\n",
  "tomme linjer først": "\n\n# T\n\ntekst\n",
  fremhævning: "_kursiv_ og __fed__ og *k* og **f**\n",
  overskrifter: "Titel\n=====\n\n## Overskrift ##\n",
  specialtegn: "3*4 = 12 og a_b_c og <tag> & mere\n",
  kodeblokke: "```js\nconst a = 1;\n\nconst b = 2;\n```\n\n    indrykket kode\n\n~~~\ntilde\n~~~\n",
  vandrette: "***\n\n___\n\n- - -\n",
  html: "<div>x</div>\n\nlinje<br>linje\n",
  links: "[tekst](https://x.dk) og <https://y.dk> og https://z.dk\n",
  "hårde linjeskift": "a  \nb\n\nc\\\nd\n",
  "fed før blødt linjeskift": "**Maria:**\nJa, det er rigtigt.\n",
  referencelinks: "[a][1] og [b][2]\n\n[1]: https://x.dk\n[2]: https://y.dk\n",
  billeder: "![alt](sti/billede.png)\n",
  "afsnit og liste i samme blok": "Roller og ansvar\n* en\n* to\n\n* tre\n",
};

describe("splitFrontmatter", () => {
  it("tager kun --- på første linje til næste ---", () => {
    expect(splitFrontmatter("---\na: 1\n---\nTekst")).toEqual({ frontmatter: "---\na: 1\n---\n", body: "Tekst" });
    expect(splitFrontmatter("---\r\na: 1\r\n---\r\n\r\nTekst")).toEqual({
      frontmatter: "---\r\na: 1\r\n---\r\n",
      body: "\r\nTekst",
    });
    expect(splitFrontmatter("---\na: 1\n---")).toEqual({ frontmatter: "---\na: 1\n---", body: "" });
    expect(splitFrontmatter("---\nikke afsluttet\n")).toEqual({ frontmatter: "", body: "---\nikke afsluttet\n" });
    expect(splitFrontmatter("Tekst\n---\na: 1\n---\n").frontmatter).toBe("");
    expect(splitFrontmatter("----\na\n---\n").frontmatter).toBe("");
  });
});

describe("serialisering", () => {
  it("retter escapede wikilinks", () => {
    expect(unescapeWikilinks("Se \\[\\[Note\\]\\] og !\\[\\[a.png\\]\\]")).toBe("Se [[Note]] og ![[a.png]]");
  });

  it("den skjulte serializer giver det samme som editoren", () => {
    for (const src of Object.values(SAMPLES)) {
      const { body } = splitFrontmatter(src);
      const editor = new Editor({ extensions: schemaExtensions(), content: body, injectCSS: false });
      expect(normalizeMarkdown(body)).toBe(getMarkdown(editor));
      editor.destroy();
    }
  });
});

describe("bevar urørt markdown", () => {
  it("uden redigering gemmes noten byte for byte som før", () => {
    for (const [name, src] of Object.entries(SAMPLES)) {
      const { body } = splitFrontmatter(src);
      const editor = new Editor({ extensions: schemaExtensions(), content: body, injectCSS: false });
      const out = splitFrontmatter(src).frontmatter + preserveMarkdown(body, getMarkdown(editor));
      expect(out, name).toBe(src);
      editor.destroy();
    }
  });

  it("en redigering et andet sted lader hver slags blok stå urørt", () => {
    for (const [name, sample] of Object.entries(SAMPLES)) {
      if (name === "ingen afsluttende linjeskift" || name === "CRLF") continue; // testes for sig
      if (name === "billeder") continue; // se testen af sikkerhedsnettet
      const src = `${sample.replace(/\n*$/, "")}\n\nSidste afsnit.\n`;
      const note = open(src);
      replace(note.editor, "Sidste afsnit.", "Sidste afsnit, rettet.");
      expect(note.save(), name).toBe(src.replace("Sidste afsnit.", "Sidste afsnit, rettet."));
      note.editor.destroy();
    }
  });

  it("ændrer kun den redigerede blok", () => {
    const src = "# Møde\n\nFørste linje\nanden linje\n\n* punkt a\n* punkt b\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
    const note = open(src);
    replace(note.editor, "punkt b", "punkt B");
    expect(note.save()).toBe(src.replace("punkt b", "punkt B"));
    replace(note.editor, "anden linje", "anden linje!");
    // enkelte linjeskift er linjeskift (Obsidian-stil) og bevares i den redigerede blok
    expect(note.save()).toBe(
      "# Møde\n\nFørste linje\nanden linje!\n\n* punkt a\n* punkt B\n\n| a | b |\n|---|---|\n| 1 | 2 |\n"
    );
    note.editor.destroy();
  });

  it("tilbagerullet redigering giver kilden igen", () => {
    const src = "Linje a\nLinje b\n\n* x\n";
    const note = open(src);
    replace(note.editor, "Linje b", "Linje c");
    expect(note.save()).not.toBe(src);
    replace(note.editor, "Linje c", "Linje b");
    expect(note.save()).toBe(src);
    note.editor.destroy();
  });

  it("sletter og indsætter blokke uden at røre resten", () => {
    const src = "Et\nto\n\n\nTre\nfire\n\n* fem\n* seks\n";
    const deleted = open(src);
    deleteBlock(deleted.editor, "Tre");
    expect(deleted.save()).toBe("Et\nto\n\n\n* fem\n* seks\n");
    deleted.editor.destroy();

    const inserted = open(src);
    insertParagraphAfter(inserted.editor, "Tre", "Nyt afsnit");
    expect(inserted.save()).toBe("Et\nto\n\n\nTre\nfire\n\nNyt afsnit\n\n* fem\n* seks\n");
    inserted.editor.destroy();
  });

  it("nye punkter i en *-liste får samme listetegn", () => {
    const tight = open("* en\n* to\n* tre\n");
    replace(tight.editor, "to", "to!");
    expect(tight.save()).toBe("* en\n* to!\n* tre\n");
    tight.editor.destroy();

    const loose = open("# Liste\n\n* en\n\t* under\n* to\n\n* tre\n\n* fire\n");
    replace(loose.editor, "fire", "fire!");
    expect(loose.save()).toBe("# Liste\n\n* en\n\t* under\n* to\n\n* tre\n\n* fire!\n");
    loose.editor.destroy();
  });

  it("beholder frontmatter, CRLF og afsluttende linjeskift ved redigering", () => {
    const fm = open("---\ntags: x\n---\n\n# T\n\ntekst\n");
    replace(fm.editor, "tekst", "ny tekst");
    expect(fm.save()).toBe("---\ntags: x\n---\n\n# T\n\nny tekst\n");
    fm.editor.destroy();

    const crlf = open("# T\r\n\r\nLinje a\r\nLinje b\r\n\r\n* x\r\n* y\r\n");
    replace(crlf.editor, "x", "x2");
    expect(crlf.save()).toBe("# T\r\n\r\nLinje a\r\nLinje b\r\n\r\n* x2\r\n* y\r\n");
    insertParagraphAfter(crlf.editor, "T", "Ny");
    expect(crlf.save()).toBe("# T\r\n\r\nNy\r\n\r\nLinje a\r\nLinje b\r\n\r\n* x2\r\n* y\r\n");
    crlf.editor.destroy();

    const bare = open("# T\n\ntekst");
    replace(bare.editor, "tekst", "ny");
    expect(bare.save()).toBe("# T\n\nny");
    bare.editor.destroy();
  });

  it("frontmatter uden afsluttende linjeskift: skrevet tekst kommer på sin egen linje", () => {
    for (const [src, nl] of [
      ["---\ntags: møde\n---", "\n"],
      ["---\r\ntags: møde\r\n---", "\r\n"],
    ]) {
      const note = open(src);
      note.editor.commands.insertContent("Hej");
      const out = note.save();
      expect(out).toBe(`${src}${nl}Hej`);
      expect(splitFrontmatter(out)).toEqual({ frontmatter: `${src}${nl}`, body: "Hej" });
      // alt slettet igen: kun frontmatteren, som den var
      note.editor.commands.clearContent();
      expect(note.save()).toBe(src);
      note.editor.destroy();
    }
    expect(joinFrontmatter("", "Hej")).toBe("Hej");
    expect(joinFrontmatter("---\na: 1\n---\n", "Hej")).toBe("---\na: 1\n---\nHej");
    expect(joinFrontmatter("---\na: 1\n---\r", "Hej")).toBe("---\na: 1\n---\r\nHej");
  });

  it("en tom note får editorens tekst", () => {
    const note = open("");
    note.editor.commands.insertContent("Hej");
    expect(note.save()).toBe("Hej");
    note.editor.destroy();
  });

  it("sikkerhedsnettet bruger editorens tekst, når bevaring ville ændre betydningen", () => {
    // Det indrykkede afsnit står alene i kilden. Gøres afsnittet over til et
    // listepunkt, ville den bevarede originaltekst blive en del af punktet.
    const note = open("Afsnit\n\n  indrykket afsnit\n");
    note.editor.chain().setTextSelection(2).toggleBulletList().run();
    const md = getMarkdown(note.editor);
    expect(md).toBe("- Afsnit\n\nindrykket afsnit");
    expect(normalizeMarkdown("- Afsnit\n\n  indrykket afsnit")).not.toBe(md);
    expect(note.save()).toBe(md);
    note.editor.destroy();
  });

  it("et billede afslutter sin blok, så afsnittet efter ikke klæbes på", () => {
    // tiptap-markdown skrev billedblokken uden at afslutte den:
    // ![alt](sti/billede.png)Tekst! — VaultImage skriver den nu selv
    const note = open("![alt](sti/billede.png)\n\nTekst.\n");
    replace(note.editor, "Tekst.", "Tekst!");
    const md = getMarkdown(note.editor);
    expect(md).toBe("![alt](sti/billede.png)\n\nTekst!");
    expect(note.save()).toBe("![alt](sti/billede.png)\n\nTekst!\n");
    note.editor.destroy();
  });

  it("linjeskift med mellemrum imellem deler ikke afsnittet", () => {
    const note = open("Et\n\nA\nB\n");
    replace(note.editor, "B", "B!");
    const { from } = textRange(note.editor, "A");
    note.editor.commands.command(({ tr, state }) => {
      const br = state.schema.nodes.hardBreak;
      tr.insert(from + 1, [br.create(), state.schema.text(" "), br.create()]);
      return true;
    });
    const out = note.save();
    expect(normalizeMarkdown(out.replace(/\n$/, ""))).toBe(getMarkdown(note.editor));
    expect(out.split("\n\n")).toHaveLength(2); // stadig to afsnit
    note.editor.destroy();
  });

  it("et nodenavn i en linkadresse er ikke en fallback", () => {
    const note = open("Et [Andet](https://shop.dk/s?filter[text]=sko) afsnit\n\nTo\n");
    replace(note.editor, "afsnit", "afsnit!");
    expect(note.save()).toContain("afsnit!");
    note.editor.destroy();
  });

  it("callout-markøren escapes ikke, når en faktaboks redigeres", () => {
    const note = open("> [!fakta] Overskrift\n> Tekst.\n");
    replace(note.editor, "Tekst.", "Tekst!");
    expect(note.save()).toBe("> [!fakta] Overskrift\n> Tekst!\n");
    note.editor.destroy();
  });

  it("resultatet betyder altid det samme som editorens tekst", () => {
    const src = "* a\n\n  b\n\nc\nd\n\n1. x\n1. y\n";
    const edits = ["- a\n\n  b x\n\nc d\n\n1. x\n2. y", "c d\n\n1. x\n2. y", "Helt ny tekst", "- a\n\nb\n\nc d"];
    for (const md of edits) {
      const out = preserveMarkdown(src, md);
      expect([md, normalizeMarkdown(md)]).toContain(normalizeMarkdown(out));
    }
  });
});

describe("sikkerhedsnet mod [nodenavn]", () => {
  // tiptap-markdown skriver en node, den ikke kan serialisere, som "[navn]"
  // (html:false). Sker det, beholdes blokkens tidligere tekst.
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  afterEach(() => warn.mockClear());

  const src = "Før\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nEfter\n";

  it("beholder tabellens tekst fra kilden", () => {
    expect(preserveMarkdown(src, "Før!\n\n[table]\n\nEfter")).toBe(
      "Før!\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nEfter\n"
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("[table]");
  });

  it("beholder den senest gemte udgave af blokken", () => {
    const p = createPreserver(src);
    expect(p.apply("Før\n\n| a | b |\n| --- | --- |\n| 1 | 3 |\n\nEfter")).toBe(
      "Før\n\n| a | b |\n| --- | --- |\n| 1 | 3 |\n\nEfter\n"
    );
    expect(p.apply("Før\n\n[table]\n\nEfter!")).toBe("Før\n\n| a | b |\n| --- | --- |\n| 1 | 3 |\n\nEfter!\n");
    // også ved næste tastetryk et andet sted
    expect(p.apply("Før\n\n[table]\n\nEfter!!")).toBe("Før\n\n| a | b |\n| --- | --- |\n| 1 | 3 |\n\nEfter!!\n");
    // tabellen er slettet: så er det ikke længere en fejl
    expect(p.apply("Før\n\nEfter!!")).toBe("Før\n\nEfter!!\n");
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("inline-fallback i et afsnit og i et listepunkt", () => {
    expect(preserveMarkdown("a\nb\n\nc\n", "a[hardBreak]b!\n\nc!")).toBe("a\nb\n\nc!\n");
    expect(preserveMarkdown("* a\n* b\n", "- a\n- b [taskList]")).toBe("* a\n* b\n");
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("en ny blok uden tidligere tekst udelades", () => {
    expect(preserveMarkdown("A\n\nC\n", "A\n\n[table]\n\nC")).toBe("A\n\nC\n");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("wikilinks, links, kode og tekst med nodenavne er ikke fallback", () => {
    const md =
      "Se [[table]] og [image](https://x.dk) og `[table]` og \\[text\\] og <https://x.dk/[image]>\n\n" +
      "```\n[table]\n```\n\n- [paragraph][1]";
    expect(preserveMarkdown("Start\n", md)).toBe(`${md}\n`);
    expect(warn).not.toHaveBeenCalled();
  });
});
