// @vitest-environment jsdom
// Kører bevaringen mod alle noter i den rigtige vault (kun læsning).
// Springes over på maskiner uden vaulten.
import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { schemaExtensions } from "./components/layoutExtensions";
import { createPreserver, getMarkdown, joinFrontmatter, normalizeMarkdown, splitFrontmatter } from "./markdownPreserve";

// Node-API'er hentes dynamisk: projektet har ikke @types/node, og tsc tjekker også testfilerne
interface Dirent {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}
interface Fs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: "utf8"): string;
  readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
}
const fs = (await import(/* @vite-ignore */ "node:fs" as string)) as Fs;

const VAULT = "/Users/kristian/Vaults/noter-og-filer";

// jsdoms selektor-cache holder fast i hvert dokument, der er søgt i, og
// parseren laver et nyt dokument pr. kald — over hele vaulten løber testen
// tør for hukommelse. Her genbruges ét dokument (samme HTML-parser).
const shared = document.implementation.createHTMLDocument("");
window.DOMParser = class {
  parseFromString(html: string) {
    shared.documentElement.innerHTML = html;
    return shared;
  }
} as unknown as typeof DOMParser;

// som desktopens collect_md: kun .md, intet der starter med punktum
function collectMd(dir: string, rel = "", out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) collectMd(`${dir}/${entry.name}`, path, out);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) out.push(path);
  }
  return out;
}

function loadEditor(body: string): Editor {
  return new Editor({ extensions: schemaExtensions(), content: body, injectCSS: false });
}

// tilføjer et ord sidst i notens sidste afsnit, som når man skriver;
// false = noten har intet afsnit
function appendWord(editor: Editor): boolean {
  let last: { node: PMNode; pos: number } | null = null;
  editor.state.doc.descendants((node: PMNode, pos: number) => {
    if (node.type.name === "paragraph") last = { node, pos };
  });
  if (!last) return false;
  const { node, pos } = last as { node: PMNode; pos: number };
  const tail = node.lastChild;
  const space = tail?.isText && !/\s$/.test(tail.text ?? "") ? " " : "";
  return editor.commands.command(({ tr }) => {
    tr.insertText(space + "mobilord", pos + node.nodeSize - 1);
    return true;
  });
}

// Linjer i kilden, der ikke står uændret først eller sidst i resultatet
function changedLineRange(before: string, after: string): [number, number] | null {
  const a = before.split("\n");
  const b = after.split("\n");
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  if (p === a.length && p === b.length) return null;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return [p, a.length - s - 1];
}

// Blokke, som en læser ser dem: adskilt af tomme linjer, men en kodeblok,
// en indrykket fortsættelse (fx et listepunkts næste afsnit) og næste punkt
// i en løs liste (samme listetegn efter en tom linje) hører til blokken
// ovenover. [første, sidste] linje.
const listMarker = (line: string) => line.match(/^([*+-]|\d+[.)])[ \t]/)?.[1].replace(/\d+/, "1");

function noteBlocks(text: string): [number, number][] {
  const blocks: [number, number][] = [];
  let start = -1;
  let end = -1;
  let fence = false;
  let gap = false;
  let marker: string | undefined;
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/\r$/, "");
    const isFence = /^ {0,3}(```|~~~)/.test(line);
    if (fence) {
      end = i;
      if (isFence) fence = false;
      return;
    }
    if (/^[ \t]*$/.test(line)) {
      gap = start !== -1;
      return;
    }
    const sameList = marker !== undefined && listMarker(line) === marker;
    if (gap && !/^[ \t]/.test(line) && !sameList) {
      blocks.push([start, end]);
      start = -1;
    }
    gap = false;
    if (start === -1) {
      start = i;
      marker = undefined;
    }
    marker ??= listMarker(line);
    end = i;
    fence = isFence;
  });
  if (start !== -1) blocks.push([start, end]);
  return blocks;
}

const ms = (t: number) => Math.round(t * 10) / 10;

describe.skipIf(!fs.existsSync(VAULT))("vaultens noter", () => {
  const files = fs.existsSync(VAULT) ? collectMd(VAULT) : [];
  const notes = files.map((path) => ({ path, src: fs.readFileSync(`${VAULT}/${path}`, "utf8") }));

  it("uden redigering gemmes hver note præcis som før", { timeout: 600_000 }, () => {
    const failures: string[] = [];
    for (const { path, src } of notes) {
      const { frontmatter, body } = splitFrontmatter(src);
      const editor = loadEditor(body);
      const md = getMarkdown(editor);
      editor.destroy();
      // uden editorens første serialisering: den skjulte serializer skal give det samme
      if (frontmatter + createPreserver(body).apply(md) !== src) failures.push(path);
    }
    console.log(`[vault] ${notes.length} noter: ${notes.length - failures.length} gemt uændret`);
    expect(failures).toEqual([]);
  });

  it("en redigering ændrer kun den redigerede blok", { timeout: 600_000 }, () => {
    const outside: string[] = [];
    const lost: string[] = [];
    let edited = 0;
    let exact = 0;
    let changedLines = 0;
    for (const { path, src } of notes) {
      const { frontmatter, body } = splitFrontmatter(src);
      const editor = loadEditor(body);
      const preserver = createPreserver(body, getMarkdown(editor));
      if (!appendWord(editor)) {
        editor.destroy();
        continue;
      }
      edited++;
      const md = getMarkdown(editor);
      editor.destroy();
      const outBody = preserver.apply(md);
      const out = joinFrontmatter(frontmatter, outBody);
      // frontmatter bevaret og redigeringen med
      if (!out.startsWith(frontmatter) || !outBody.includes("mobilord")) lost.push(path);
      // genindlæst giver resultatet editorens tekst eller det samme som
      // editorens tekst genindlæst (= før), segment for segment
      const reloaded = normalizeMarkdown(outBody);
      if (reloaded === md) exact++;
      else if (reloaded !== normalizeMarkdown(md)) {
        const known = new Set([...md.split("\n"), ...normalizeMarkdown(md).split("\n")]);
        if (reloaded.split("\n").some((l) => !known.has(l))) lost.push(path);
      }
      const range = changedLineRange(src, out);
      if (!range) continue;
      changedLines += range[1] - range[0] + 1;
      const offset = frontmatter.split("\n").length - 1;
      const blocks = noteBlocks(body).map(([from, to]) => [from + offset, to + offset]);
      if (!blocks.length) continue; // tom note: alt er nyt
      if (!blocks.some(([from, to]) => from <= range[0] && range[1] <= to)) {
        outside.push(`${path}: linje ${range[0] + 1}–${range[1] + 1}`);
      }
    }
    console.log(
      `[vault] redigeret ${edited} noter: ${edited - outside.length} kun ændret i den redigerede blok, ` +
        `${outside.length} også uden for; ${changedLines} ændrede linjer i alt; ` +
        `genindlæst præcis som editoren: ${exact}`
    );
    if (outside.length) console.log(outside.join("\n"));
    expect(lost).toEqual([]);
    expect(outside).toEqual([]);
  });

  // Indrykkede linjer med listetegn under en tekstlinje er fortsættelse af
  // afsnittet (linjeskift + "- …"). Redigeres afsnittet, må de ikke blive
  // til en liste: genindlæst skal noten give præcis det redigerede dokument.
  it("indrykkede listetegn i et afsnit ændrer ikke betydning ved redigering", { timeout: 600_000 }, () => {
    const marker = /^([-+*]|\d{1,9}[.)])[ \t]/;
    const changed: string[] = [];
    let withMarkers = 0;
    let lines = 0;
    for (const { path, src } of notes) {
      const { body } = splitFrontmatter(src);
      const editor = loadEditor(body);
      const ends: number[] = [];
      editor.state.doc.descendants((node: PMNode, pos: number) => {
        if (node.type.name !== "paragraph") return;
        let hits = 0;
        node.forEach((child, _, i) => {
          if (i && node.child(i - 1).type.name === "hardBreak" && marker.test(child.text ?? "")) hits++;
        });
        if (hits) ends.push(pos + node.nodeSize - 1);
        lines += hits;
      });
      if (!ends.length) {
        editor.destroy();
        continue;
      }
      withMarkers++;
      const preserver = createPreserver(body, getMarkdown(editor));
      for (const at of ends.reverse()) {
        editor.commands.command(({ tr }) => {
          tr.insertText(" mobilord", at);
          return true;
        });
      }
      const expected = JSON.stringify(editor.getJSON());
      const out = preserver.apply(getMarkdown(editor));
      editor.destroy();
      const reloaded = loadEditor(out);
      if (JSON.stringify(reloaded.getJSON()) !== expected) changed.push(path);
      reloaded.destroy();
    }
    console.log(
      `[vault] ${withMarkers} noter med ${lines} indrykkede listetegn i afsnit: ` +
        `${withMarkers - changed.length} genindlæst uændret efter redigering`
    );
    expect(withMarkers).toBeGreaterThan(0);
    expect(changed).toEqual([]);
  });

  // Hver tabel redigeres i sidste rækkes første celle; genindlæst skal noten
  // give præcis det redigerede dokument (ingen "[table]", ingen forskudte celler)
  it("tabeller overlever en redigering i en celle", { timeout: 600_000 }, () => {
    const changed: string[] = [];
    let tables = 0;
    let withTables = 0;
    for (const { path, src } of notes) {
      const { body } = splitFrontmatter(src);
      const editor = loadEditor(body);
      const cells: { at: number; text: string }[] = [];
      editor.state.doc.descendants((node: PMNode, pos: number) => {
        if (node.type.name !== "table") return;
        const lastRow = node.lastChild!;
        let offset = 1; // ind i tabellen
        for (let i = 0; i < node.childCount - 1; i++) offset += node.child(i).nodeSize;
        const block = lastRow.firstChild!.firstChild!;
        // ind i rækken, cellen og cellens første blok, til dens slutning;
        // en tom celle får ordet uden mellemrum foran (GFM trimmer celler)
        const at = pos + offset + 1 + 1 + block.nodeSize - 1;
        cells.push({ at, text: block.textContent.trim() ? " mobilord" : "mobilord" });
        return false;
      });
      if (!cells.length) {
        editor.destroy();
        continue;
      }
      withTables++;
      tables += cells.length;
      const preserver = createPreserver(body, getMarkdown(editor));
      for (const { at, text } of cells.reverse()) {
        editor.commands.command(({ tr }) => {
          tr.insertText(text, at);
          return true;
        });
      }
      const expected = JSON.stringify(editor.getJSON());
      const out = preserver.apply(getMarkdown(editor));
      editor.destroy();
      const reloaded = loadEditor(out);
      if (out.includes("[table]") || JSON.stringify(reloaded.getJSON()) !== expected) changed.push(path);
      reloaded.destroy();
    }
    console.log(
      `[vault] ${tables} tabeller i ${withTables} noter: ${withTables - changed.length} noter genindlæst uændret`
    );
    expect(changed).toEqual([]);
  });

  it("er hurtig nok på den største note", { timeout: 600_000 }, () => {
    const biggest = notes.reduce((a, b) => (b.src.length > a.src.length ? b : a), notes[0]);
    const { body } = splitFrontmatter(biggest.src);
    const editor = loadEditor(body);
    const preserver = createPreserver(body, getMarkdown(editor));
    const time = () => {
      const md = getMarkdown(editor);
      const t0 = performance.now();
      preserver.apply(md);
      return performance.now() - t0;
    };
    // skriv i sidste afsnit, et tegn ad gangen
    const typing: number[] = [];
    for (let i = 0; i < 6; i++) {
      appendWord(editor);
      typing.push(time());
    }
    // ret derefter 40 steder spredt ud over noten (de tidligere rettelser bliver stående)
    const ends: number[] = [];
    editor.state.doc.descendants((node: PMNode, pos: number) => {
      if (node.type.name === "paragraph" && node.content.size) ends.push(pos + node.nodeSize - 1);
    });
    const spread: number[] = [];
    const step = Math.max(1, Math.floor(ends.length / 40));
    for (let i = ends.length - 1; i >= 0; i -= step) {
      editor.commands.command(({ tr }) => {
        tr.insertText("x", ends[i]);
        return true;
      });
      spread.push(time());
    }
    editor.destroy();
    const median = (xs: number[]) => ms([...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]);
    const kb = Math.round(new TextEncoder().encode(biggest.src).length / 1024);
    console.log(
      `[vault] største note ${biggest.path} (${kb} KB): ` +
        `første kald ${ms(typing[0])} ms, derefter median ${median(typing.slice(1))} ms; ` +
        `${spread.length} rettelser spredt i noten: median ${median(spread)} ms, max ${ms(Math.max(...spread))} ms`
    );
    expect(median(typing.slice(1))).toBeLessThan(30);
  });
});
