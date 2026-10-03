// Layout-visningen skriver hele noten om ved hver redigering: tiptap-markdown
// slår bløde linjeskift sammen, normaliserer listemarkører og tabeller og
// ødelægger YAML-frontmatter. Her bevares kildeteksten for alle blokke,
// brugeren ikke har rørt, så en redigering kun giver diff i den blok.
//
// Fremgang: kilden deles i blokke (adskilt af tomme linjer), og hver blok
// får sin normaliserede form — som den står i editorens serialisering lige
// efter indlæsningen. Editorens aktuelle serialisering deles også i blokke,
// og de to rækker matches (LCS). En kildeblok, hvis normaliserede form står
// uændret, skrives med sin originaltekst.
// Sikkerhedsnet: resultatet skal parses til præcis det samme som editorens
// serialisering; ellers bruges editorens serialisering (= adfærden før).
// Det tjekkes i segmenter, så et tastetryk i en stor note kun koster en
// parse af det redigerede stykke.

import { Editor, createDocument } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { schemaExtensions } from "./components/layoutExtensions";

// ---------- frontmatter ----------

const FM_LINE = /^---[ \t]*\r?$/;

// YAML-frontmatter: "---" på allerførste linje til næste "---"-linje
// (inkl. dennes linjeskift). Uden afslutning er der ingen frontmatter.
export function splitFrontmatter(src: string): { frontmatter: string; body: string } {
  if (!src.startsWith("---")) return { frontmatter: "", body: src };
  let nl = src.indexOf("\n");
  if (nl === -1 || !FM_LINE.test(src.slice(0, nl))) return { frontmatter: "", body: src };
  while (nl !== -1) {
    const start = nl + 1;
    nl = src.indexOf("\n", start);
    if (FM_LINE.test(src.slice(start, nl === -1 ? src.length : nl))) {
      const end = nl === -1 ? src.length : nl + 1;
      return { frontmatter: src.slice(0, end), body: src.slice(end) };
    }
  }
  return { frontmatter: "", body: src };
}

// Frontmatter og krop samles igen. Var noten kun frontmatter uden
// afsluttende linjeskift, sættes et ind; ellers kom ny tekst på "---"-linjen,
// og frontmatteren var ikke længere afsluttet.
export function joinFrontmatter(frontmatter: string, body: string): string {
  if (!frontmatter || !body || frontmatter.endsWith("\n")) return frontmatter + body;
  const nl = frontmatter.endsWith("\r") ? "\n" : frontmatter.includes("\r\n") ? "\r\n" : "\n";
  return frontmatter + nl + body;
}

// ---------- serialisering ----------

// serialiseringen escaper alle kantparenteser, hvilket ødelægger
// wikilinks og indlejrede billeder: \[\[Note\]\] → [[Note]] — og
// callout-markøren i citater: > \[!fakta\] → > [!fakta]
export function unescapeWikilinks(md: string): string {
  return md
    .replace(/(!?)\\\[\\\[([^\][\n]*?)\\\]\\\]/g, "$1[[$2]]")
    .replace(/^((?:[ \t]*>)+[ \t]*)\\\[!([^\]\n]+?)\\\]/gm, "$1[!$2]");
}

interface MarkdownIt {
  use: (plugin: unknown, ...args: unknown[]) => MarkdownIt;
  block: { parse: (src: string, md: MarkdownIt, env: MdEnv, out: MdToken[]) => void };
}

interface MdEnv {
  references?: Record<string, unknown>;
}

interface MdToken {
  type: string;
  level: number;
  nesting: number;
  map: [number, number] | null;
}

interface MarkdownStorage {
  getMarkdown: () => string;
  parser: { parse: (md: string) => string; md: MarkdownIt };
  serializer: { serialize: (doc: PMNode) => string };
}

function markdownStorage(editor: Editor): MarkdownStorage {
  return (editor.storage as unknown as { markdown: MarkdownStorage }).markdown;
}

// Editorens indhold som markdown
export function getMarkdown(editor: Editor): string {
  return unescapeWikilinks(markdownStorage(editor).getMarkdown());
}

let headless: Editor | null = null;

// Én genbrugt editor uden visning; kun dens skema, parser og serializer bruges
function headlessEditor(): Editor {
  if (headless && !headless.isDestroyed) return headless;
  const editor = new Editor({ extensions: schemaExtensions(), injectCSS: false });
  // tiptap-markdown registrerer tjekliste-pluginnet i markdown-it ved hvert
  // parse-kald, så reglerne hober sig op (resultatet er det samme efter
  // første gang); her registreres hvert plugin kun én gang
  const md = markdownStorage(editor).parser.md;
  const use = md.use.bind(md);
  const used = new Set<unknown>();
  md.use = (plugin, ...args) => {
    if (!used.has(plugin)) {
      used.add(plugin);
      use(plugin, ...args);
    }
    return md;
  };
  headless = editor;
  return editor;
}

// markdown → dokument → markdown ad samme vej, som editoren indlæser en note
export function normalizeMarkdown(md: string): string {
  const editor = headlessEditor();
  const storage = markdownStorage(editor);
  const doc = createDocument(storage.parser.parse(md), editor.schema);
  return unescapeWikilinks(storage.serializer.serialize(doc as PMNode));
}

// ---------- fallback ----------

// En node, tiptap-markdown ikke kan skrive som markdown, bliver med html:false
// til teksten "[nodenavn]" (fx "[table]"). Almindelig tekst escapes ("\[…\]"),
// så et "[nodenavn]" uden for kode, autolinks, wikilinks, links ([tekst](url),
// [tekst][ref], ![alt](…)) og linkadresser er altid en fallback.
let fallbackPattern: RegExp | null = null;

function fallbackCounts(md: string): Map<string, number> {
  fallbackPattern ??= new RegExp(`\\[(${Object.keys(headlessEditor().schema.nodes).join("|")})\\]`, "g");
  const counts = new Map<string, number>();
  let fence: string | null = null;
  for (const line of md.split("\n")) {
    const f = /^[ \t>]*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      continue;
    }
    if (f) {
      fence = f[1];
      continue;
    }
    for (const m of line.matchAll(fallbackPattern)) {
      const at = m.index ?? 0;
      if ("\\[!".includes(line[at - 1] || " ") || "[](:".includes(line[at + m[0].length] || " ")) continue;
      // inde i inline-kode (ulige antal ` før) eller et autolink (et < uden >)
      const before = line.slice(0, at);
      if ((before.split("`").length - 1) % 2 || before.lastIndexOf("<") > before.lastIndexOf(">")) continue;
      // inde i en linkadresse eller billedsti: [tekst](…[navn]…)
      if (/\]\([^)\s]*$/.test(before)) continue;
      counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    }
  }
  return counts;
}

// Erstatter blokke i `md`, der indeholder en fallback, med deres tekst i
// `prev` (den senest gemte serialisering). Blokkene matches som i bevaringen;
// et ændret stykke med lige mange blokke på begge sider parres blok for blok,
// ellers beholdes hele stykket fra `prev`. Fandtes blokken ikke før, udelades den.
function restoreFallbackBlocks(md: string, prev: string): string {
  const eB = blocksFromLines(splitLines(md));
  const pB = blocksFromLines(splitLines(prev));
  const eT = eB.map((b) => md.slice(b.start, b.end));
  const pT = pB.map((b) => prev.slice(b.start, b.end));
  const map = matchBlocks(eT, pT);
  const bad = eT.map((t, j) => map[j] < 0 && fallbackCounts(t).size > 0);
  const edits: { from: number; to: number; text: string }[] = [];
  for (let j = 0; j < eT.length; ) {
    if (map[j] >= 0) {
      j++;
      continue;
    }
    let j1 = j;
    while (j1 + 1 < eT.length && map[j1 + 1] < 0) j1++;
    const k0 = j > 0 ? map[j - 1] + 1 : 0;
    const k1 = j1 + 1 < eT.length ? map[j1 + 1] - 1 : pT.length - 1;
    const run = j1 - j + 1;
    const region = Math.max(0, k1 - k0 + 1);
    if (bad.slice(j, j1 + 1).some(Boolean)) {
      if (run === region) {
        for (let t = 0; t < run; t++) {
          if (bad[j + t]) edits.push({ from: eB[j + t].start, to: eB[j + t].end, text: pT[k0 + t] });
        }
      } else if (!region) {
        for (let t = j; t <= j1; t++) {
          if (bad[t]) edits.push({ from: t > 0 ? eB[t - 1].end : eB[t].start, to: eB[t].end, text: "" });
        }
      } else {
        edits.push({ from: eB[j].start, to: eB[j1].end, text: prev.slice(pB[k0].start, pB[k1].end) });
      }
    }
    j = j1 + 1;
  }
  let out = md;
  for (const { from, to, text } of edits.reverse()) out = out.slice(0, from) + text + out.slice(to);
  return out;
}

// ---------- blokke ----------

interface Span {
  start: number; // blokkens første tegn
  end: number; // efter blokkens sidste tegn (uden linjeskift)
}

interface Line extends Span {
  blank: boolean;
}

interface Block extends Span {
  line: number; // første og sidste linje (0-indekseret)
  endLine: number;
}

function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let pos = 0;
  for (;;) {
    let nl = text.indexOf("\n", pos);
    const last = nl === -1;
    if (last) nl = text.length;
    const end = nl > pos && text.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
    let blank = true;
    for (let i = pos; i < end && blank; i++) {
      const c = text.charCodeAt(i);
      blank = c === 32 || c === 9;
    }
    lines.push({ start: pos, end, blank });
    if (last) return lines;
    pos = nl + 1;
  }
}

// Blokke adskilt af tomme linjer; glued[i] = tom linje i deler ikke
function blocksFromLines(lines: Line[], glued?: Uint8Array): Block[] {
  const blocks: Block[] = [];
  let first = -1;
  let last = -1;
  const close = () => {
    if (first === -1) return;
    blocks.push({ start: lines[first].start, end: lines[last].end, line: first, endLine: last });
    first = -1;
  };
  lines.forEach((line, i) => {
    if (!line.blank) {
      if (first === -1) first = i;
      last = i;
    } else if (!glued?.[i]) {
      close();
    }
  });
  close();
  return blocks;
}

function blockTexts(text: string): string[] {
  return blocksFromLines(splitLines(text)).map((b) => text.slice(b.start, b.end));
}

interface SourceInfo {
  blocks: Block[];
  refs: boolean; // linkdefinitioner ([navn]: url) virker på tværs af blokke
  anchors: { line: number; type: string }[]; // se anchorsOf
  anchorLines: Set<number>;
  tokenLines: Set<number>; // linjer, hvor en markdown-blok starter
}

function parseBlocks(text: string): { tokens: MdToken[]; env: MdEnv } {
  const tokens: MdToken[] = [];
  const env: MdEnv = {};
  const md = markdownStorage(headlessEditor()).parser.md;
  md.block.parse(text.replace(/\r\n/g, "\n").replace(/\0/g, "\uFFFD"), md, env, tokens);
  return { tokens, env };
}

// Blokke øverst i teksten og punkter i lister øverst, i rækkefølge. De
// findes også i samme rækkefølge efter normalisering (indrykket kode
// bliver dog til en kodeblok med ```).
function anchorsOf(tokens: MdToken[]): { line: number; type: string }[] {
  const anchors: { line: number; type: string }[] = [];
  for (const t of tokens) {
    if (!t.map) continue;
    const top = t.level === 0 && t.nesting >= 0;
    const item = t.type === "list_item_open" && t.level === 1;
    if (top || item) anchors.push({ line: t.map[0], type: t.type === "code_block" ? "fence" : t.type });
  }
  return anchors;
}

// Kildens blokke. En kodeblok med tomme linjer eller et listepunkt med
// flere afsnit holdes samlet, så blokken kan normaliseres alene og stadig
// give det samme som i sammenhængen.
function sourceInfo(text: string): SourceInfo {
  const lines = splitLines(text);
  // et ensomt \r er et linjeskift for markdown-it; så passer linjenumrene ikke
  if (/\r(?!\n)/.test(text)) {
    const none = new Set<number>();
    return { blocks: blocksFromLines(lines), refs: true, anchors: [], anchorLines: none, tokenLines: none };
  }
  const { tokens, env } = parseBlocks(text);
  const glued = new Uint8Array(lines.length);
  const tokenLines = new Set<number>();
  for (const t of tokens) {
    if (!t.map) continue;
    tokenLines.add(t.map[0]);
    const item = t.type === "list_item_open" && t.level === 1;
    if (!item && t.type !== "fence" && t.type !== "code_block") continue;
    let [from, to] = t.map;
    to = Math.min(to, lines.length);
    while (to > from && lines[to - 1].blank) to--;
    for (let i = from; i < to; i++) if (lines[i].blank) glued[i] = 1;
  }
  const anchors = anchorsOf(tokens);
  return {
    blocks: blocksFromLines(lines, glued),
    refs: Object.keys(env.references ?? {}).length > 0,
    anchors,
    anchorLines: new Set(anchors.map((a) => a.line)),
    tokenLines,
  };
}

const LIST_START = /^([-+*]|\d{1,9}[.)])([ \t\r]|$)/;
const BULLET = /^([-+*])[ \t]/;
const FENCE = /^[ \t]*(```|~~~)/;

// Kan intet før en tom linje fortsætte ind i blokken? Det gælder, når den
// starter uden indrykning og uden listemarkør (ellers kan den høre til en
// liste eller indrykket kode ovenover). Så kan teksten på hver side af
// den tomme linje parses og serialiseres hver for sig.
function standsAlone(text: string): boolean {
  const c = text.charCodeAt(0);
  if (c === 32 || c === 9) return false;
  const nl = text.indexOf("\n");
  return !LIST_START.test(nl === -1 ? text : text.slice(0, nl));
}

// Afsnit uden betydning, der skiller tekster ved samlet normalisering
// (ét parse-kald i stedet for ét pr. tekst)
const MARK = "mwpreserveblockbreak7c1e";

// tiptap-markdown flytter mellemrum ud af fed/kursiv — undtagen når
// markeringen står allerførst i noten (en fejl i dens serializer). En tekst,
// der ikke står først i noten, normaliseres derfor med et afsnit foran.
function normalizeAfterStart(md: string): string {
  const out = normalizeMarkdown(`${MARK}\n\n${md}`);
  if (out.startsWith(`${MARK}\n\n`)) return out.slice(MARK.length + 2);
  return out === MARK ? "" : normalizeMarkdown(md);
}

// Normaliserer hver tekst for sig. Teksterne sendes samlet gennem én parse
// med et skille-afsnit imellem; passer antallet af skel ikke bagefter,
// normaliseres de én ad gangen. `atStart` = den første tekst står
// allerførst i noten (se normalizeAfterStart).
function normalizeEach(texts: string[], atStart: boolean): string[] {
  if (!texts.length) return [];
  const lead = atStart ? "" : `${MARK}\n\n`;
  const joined = normalizeMarkdown(lead + texts.join(`\n\n${MARK}\n\n`));
  const out: string[] = [];
  let first = -1;
  let last = -1;
  for (const b of blocksFromLines(splitLines(joined))) {
    if (joined.slice(b.start, b.end) === MARK) {
      out.push(first === -1 ? "" : joined.slice(first, last));
      first = -1;
    } else {
      if (first === -1) first = b.start;
      last = b.end;
    }
  }
  out.push(first === -1 ? "" : joined.slice(first, last));
  if (!atStart && out.shift() !== "") out.length = 0;
  if (out.length === texts.length) return out;
  return texts.map((t, i) => (atStart && i === 0 ? normalizeMarkdown(t) : normalizeAfterStart(t)));
}

// ---------- matchning ----------

// For hver blok i a: indekset på dens makker i b (LCS), ellers -1.
// Fælles begyndelse og slutning matches først, så LCS kun regnes på
// det stykke, der faktisk er ændret.
function matchBlocks(a: string[], b: string[]): Int32Array {
  const map = new Int32Array(a.length).fill(-1);
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) {
    map[lo] = lo;
    lo++;
  }
  let ha = a.length;
  let hb = b.length;
  while (ha > lo && hb > lo && a[ha - 1] === b[hb - 1]) {
    map[ha - 1] = hb - 1;
    ha--;
    hb--;
  }
  const m = ha - lo;
  const n = hb - lo;
  // meget store ændrede stykker (fx en kæmpe indsættelse) matches ikke
  if (m === 0 || n === 0 || m * n > 4_000_000) return map;
  const w = n + 1;
  const dp = new Int32Array((m + 1) * w);
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[lo + i] === b[lo + j]
          ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[lo + i] === b[lo + j]) {
      map[lo + i] = lo + j;
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return map;
}

// ---------- bevaring ----------

interface Unit extends Block {
  text: string; // originaltekst
  norm: string[]; // normaliserede delblokke, som de står i noten
  alone: boolean; // standsAlone, og noten har ingen linkdefinitioner
  chunk: number; // stykke = units fra én "alone"-unit til den næste
  bullet: string | null; // listetegn, hvis blokken starter som punktliste
}

interface Piece {
  unit: number; // urørt kildeblok, -1 = ny tekst fra editoren
  first: number; // første og sidste editorblok
  last: number;
  marker: string | null; // ny punktliste: kildens listetegn i stedet for "-"
}

export interface Preserver {
  // editorens serialisering (uden frontmatter) → tekst at gemme
  apply(editorMarkdown: string): string;
  // forbered kildens blokke på forhånd (ellers sker det ved første apply)
  warm(): void;
}

// `source` er notens tekst uden frontmatter, som den blev indlæst i editoren.
// `initial` er editorens serialisering lige efter indlæsningen (udelades
// den, regnes den ud her).
export function createPreserver(source: string, initial?: string): Preserver {
  return new SourcePreserver(source, initial);
}

export function preserveMarkdown(source: string, editorMarkdown: string): string {
  return createPreserver(source).apply(editorMarkdown);
}

class SourcePreserver implements Preserver {
  private source: string;
  private initial: string | undefined;
  private crlf: boolean;
  private units: Unit[] | null = null;
  private seps: string[] = []; // seps[i] står mellem unit i og i+1
  private chunkNorms: string[] = [];
  private lead = "";
  private trail = "";
  private lastIn: string | null = null;
  private lastOut = "";
  private normalized = new Map<string, string>(); // normaliserede segmenter fra sidste kald
  private lastGood: { md: string; fallbacks: Map<string, number> } | null = null; // se guard

  constructor(source: string, initial?: string) {
    this.source = source;
    this.initial = initial;
    this.crlf = /\r\n/.test(source) && !/(^|[^\r])\n/.test(source);
  }

  apply(editorMarkdown: string): string {
    if (editorMarkdown !== this.lastIn) {
      this.lastOut = this.compute(this.guard(editorMarkdown));
      this.lastIn = editorMarkdown;
    }
    return this.lastOut;
  }

  // Sikkerhedsnet: indeholder editorens tekst flere "[nodenavn]"-fallbacks
  // end den senest godkendte, beholdes de berørte blokkes tidligere tekst
  private guard(e: string): string {
    this.initial ??= normalizeMarkdown(this.source);
    const prev = this.lastGood ?? { md: this.initial, fallbacks: fallbackCounts(this.initial) };
    const now = fallbackCounts(e);
    const added = [...now].filter(([name, n]) => n > (prev.fallbacks.get(name) ?? 0)).map(([name]) => `[${name}]`);
    if (!added.length) {
      this.lastGood = { md: e, fallbacks: now };
      return e;
    }
    console.warn(
      `Markdown Writer: ${added.join(", ")} kan ikke gemmes som markdown; blokkens tidligere tekst beholdes`
    );
    const safe = restoreFallbackBlocks(e, prev.md);
    this.lastGood = { md: safe, fallbacks: fallbackCounts(safe) };
    return safe;
  }

  warm(): void {
    this.initial ??= normalizeMarkdown(this.source);
    this.prepare();
  }

  private compute(e: string): string {
    this.initial ??= normalizeMarkdown(this.source);
    if (e === this.initial) return this.source;
    const units = this.prepare();
    if (!e) return e;
    if (!units.length) return e + this.trail;

    const eBlocks = blocksFromLines(splitLines(e));
    if (!eBlocks.length) return e;
    const eTexts = eBlocks.map((b) => e.slice(b.start, b.end));
    const flat: string[] = [];
    for (const u of units) flat.push(...u.norm);
    const map = matchBlocks(flat, eTexts);

    // cover[j] = kildeblok, der dækker editorblok j (kun hele, sammenhængende match)
    const cover = new Int32Array(eTexts.length).fill(-1);
    let k = 0;
    units.forEach((u, i) => {
      const n = u.norm.length;
      const j0 = map[k];
      let whole = j0 >= 0;
      for (let t = 1; whole && t < n; t++) whole = map[k + t] === j0 + t;
      if (whole) for (let t = 0; t < n; t++) cover[j0 + t] = i;
      k += n;
    });

    const pieces: Piece[] = [];
    for (let j = 0; j < eTexts.length; ) {
      const i = cover[j];
      const last = i >= 0 ? j + units[i].norm.length - 1 : j;
      pieces.push({ unit: i, first: j, last, marker: null });
      j = last + 1;
    }
    this.pickMarkers(pieces, eTexts);

    const fences: number[] = [];
    for (const m of e.matchAll(/^[ \t]*(```|~~~)/gm)) fences.push(m.index ?? 0);
    const fix = (s: string) => (this.crlf ? s.replace(/\n/g, "\r\n") : s);
    const eSep = (p: Piece, q: Piece) => e.slice(eBlocks[p.last].end, eBlocks[q.first].start);
    const eText = (q: Piece, adapt: boolean) => {
      const text = eTexts[q.first];
      if (!adapt || !q.marker) return text;
      // listetegn skiftes kun uden for kodeblokke
      let inFence = fences.filter((f) => f < eBlocks[q.first].start).length % 2 === 1;
      return text
        .split("\n")
        .map((line) => {
          if (FENCE.test(line)) inFence = !inFence;
          else if (!inFence && line.startsWith("- ")) return q.marker + line.slice(1);
          return line;
        })
        .join("\n");
    };

    // Segmentets tekst: urørte blokke med originaltekst, resten fra editoren.
    // Mellem to kildeblokke, der også stod side om side i kilden, bruges den
    // originale adskillelse; ved andre grænser kildens adskillelse ved siden
    // af (sourceEdges) eller editorens.
    const join = (seg: Piece[], sourceEdges: boolean, adapt: boolean) => {
      let out = "";
      seg.forEach((q, idx) => {
        if (idx > 0) {
          const p = seg[idx - 1];
          if (p.unit >= 0 && q.unit === p.unit + 1) out += this.seps[p.unit];
          else if (sourceEdges && p.unit >= 0 && p.unit < units.length - 1) out += this.seps[p.unit];
          else if (sourceEdges && q.unit > 0) out += this.seps[q.unit - 1];
          else out += fix(eSep(p, q));
        }
        out += q.unit >= 0 ? units[q.unit].text : fix(eText(q, adapt));
      });
      return out;
    };

    // Del i segmenter ved grænser, hvor begge sider er urørte kildeblokke
    // med den originale adskillelse, og hvor intet kan krydse grænsen (se
    // standsAlone). Så kan hvert segment tjekkes for sig, og et urørt
    // segment kendes allerede fra kilden.
    const segments: Piece[][] = [[]];
    pieces.forEach((q, idx) => {
      const p = pieces[idx - 1];
      if (
        p &&
        p.unit >= 0 &&
        q.unit === p.unit + 1 &&
        units[q.unit].alone &&
        eSep(p, q) === "\n\n" &&
        standsAlone(eTexts[q.first])
      ) {
        segments.push([]);
      }
      segments[segments.length - 1].push(q);
    });

    // Normaliseringer fra sidste kald genbruges: ved hvert tastetryk er det
    // kun ét segment, der er nyt; de øvrige redigerede er de samme som før
    const used = new Map<string, string>();
    const normalizeCached = (text: string, first: boolean) => {
      const key = (first ? "0" : "1") + text;
      const n =
        this.normalized.get(key) ??
        used.get(key) ??
        (first ? normalizeMarkdown(text) : normalizeAfterStart(text));
      used.set(key, n);
      return n;
    };

    let failed = false;
    const texts = segments.map((seg, s) => {
      if (failed) return "";
      const eSlice = e.slice(eBlocks[seg[0].first].start, eBlocks[seg[seg.length - 1].last].end);
      if (this.knownNorm(seg) === eSlice) return join(seg, true, false);
      // Godkendt, når segmentet parses til editorens tekst — eller til det
      // samme som editorens tekst, der ikke altid er stabil selv (fx et
      // afsluttende mellemrum, mens man skriver)
      const normalize = (text: string) => normalizeCached(text, s === 0);
      let normE: string | undefined;
      const tried = new Set<string>();
      for (const [sourceEdges, adapt] of [
        [true, true],
        [false, true],
        [false, false],
      ]) {
        const candidate = join(seg, sourceEdges, adapt);
        if (tried.has(candidate)) continue;
        tried.add(candidate);
        const n = normalize(candidate);
        if (n === eSlice) return candidate;
        normE ??= normalize(eSlice);
        if (n === normE) return candidate;
      }
      failed = true;
      return "";
    });
    this.normalized = used;
    // Et segment, der ikke kan bevares, kan skyldes, at kildens blokke er
    // fundet forkert i serialiseringen; så bruges editorens tekst helt
    if (failed) return e;

    let out = this.lead + texts[0];
    for (let s = 1; s < segments.length; s++) {
      const prev = segments[s - 1];
      out += this.seps[prev[prev.length - 1].unit] + texts[s];
    }
    return out + this.trail;
  }

  // Editoren skriver punktlister med "-". Står kildens liste med "*" eller
  // "+", får nye punkter samme tegn, så listen ikke deles i to (og diffen
  // bliver mindre). Tegnet tages fra de kildeblokke, de nye blokke erstatter,
  // eller ved ren indsættelse fra nabolisten.
  private pickMarkers(pieces: Piece[], eTexts: string[]): void {
    const units = this.units!;
    const prevUnit: number[] = [];
    let u = -1;
    pieces.forEach((q, idx) => {
      prevUnit[idx] = u;
      if (q.unit >= 0) u = q.unit;
    });
    u = units.length;
    for (let idx = pieces.length - 1; idx >= 0; idx--) {
      const q = pieces[idx];
      if (q.unit < 0 && eTexts[q.first].startsWith("- ")) {
        let marker: string | null = null;
        for (let r = prevUnit[idx] + 1; r < u && !marker; r++) marker = units[r].bullet;
        marker ??= units[prevUnit[idx]]?.bullet ?? units[u]?.bullet ?? null;
        if (marker && marker !== "-") q.marker = marker;
      }
      if (q.unit >= 0) u = q.unit;
    }
  }

  // Normaliseret tekst for et urørt segment, der består af hele stykker
  // fra kilden; null hvis det ikke kendes
  private knownNorm(seg: Piece[]): string | null {
    const units = this.units!;
    const a = seg[0].unit;
    const b = seg[seg.length - 1].unit;
    if (a < 0 || seg.some((p, t) => p.unit !== a + t)) return null;
    if (a > 0 && units[a - 1].chunk === units[a].chunk) return null;
    if (b < units.length - 1 && units[b + 1].chunk === units[b].chunk) return null;
    return this.chunkNorms.slice(units[a].chunk, units[b].chunk + 1).join("\n\n");
  }

  // Kildens blokke og deres normaliserede form; regnes én gang
  private prepare(): Unit[] {
    if (this.units) return this.units;
    const src = this.source;
    const info = sourceInfo(src);
    const blocks = info.blocks;
    // blokke uden indhold for markdown (linkdefinitioner) følger med blokken
    // før (først i noten: blokken efter), så de bevares sammen med den
    const hasContent = (b: Block) => {
      if (info.refs && !info.tokenLines.size) return true;
      for (let l = b.line; l <= b.endLine; l++) if (info.tokenLines.has(l)) return true;
      return false;
    };
    const parts: Block[] = [];
    let leading: Block | null = null;
    for (const b of blocks) {
      const prev = parts[parts.length - 1];
      if (hasContent(b)) parts.push(leading ? { ...b, start: leading.start, line: leading.line } : b);
      else if (prev) parts[parts.length - 1] = { ...prev, end: b.end, endLine: b.endLine };
      else leading ??= b;
      if (parts.length) leading = null;
    }
    const lastBlock = blocks[blocks.length - 1];

    // stykker: fra en blok, som intet kan krydse ind i, til den næste; de
    // kan normaliseres hver for sig og giver det samme som i noten
    const chunks: Block[][] = [];
    for (const b of parts) {
      const text = src.slice(b.start, b.end);
      if (!chunks.length || (!info.refs && standsAlone(text))) chunks.push([]);
      chunks[chunks.length - 1].push(b);
    }
    this.chunkNorms = this.chunkNormsFor(chunks, info);

    const units: Unit[] = [];
    chunks.forEach((c, ci) => {
      const norm = this.chunkNorms[ci];
      // flere blokke i et stykke (punkter i en løs liste): stykkets
      // normaliserede tekst deles ud på dem, ellers bliver stykket én unit
      const split = c.length > 1 ? distribute(c, norm, info) : [blockTexts(norm)];
      const whole = { ...c[0], end: c[c.length - 1].end, endLine: c[c.length - 1].endLine };
      const members = split ? c : [whole];
      members.forEach((b, t) => {
        const text = src.slice(b.start, b.end);
        units.push({
          ...b,
          text,
          norm: split ? split[t] : blockTexts(norm),
          alone: t === 0 && !info.refs && standsAlone(text),
          chunk: ci,
          bullet: BULLET.exec(text)?.[1] ?? null,
        });
      });
    });

    this.units = units;
    this.seps = units.slice(1).map((u, i) => src.slice(units[i].end, u.start));
    if (blocks.length) {
      this.lead = src.slice(0, blocks[0].start);
      this.trail = src.slice(lastBlock.end);
    } else {
      this.trail = src.endsWith("\r\n") ? "\r\n" : src.endsWith("\n") ? "\n" : "";
    }
    return units;
  }

  // Stykkernes normaliserede tekst. Så vidt muligt klippes den ud af
  // editorens første serialisering i stedet for at parse noten igen: et
  // stykkes blokke (og listepunkter) øverst skal findes i træk og af samme
  // slags dér. Resten normaliseres samlet. Til sidst skal stykkerne
  // tilsammen give præcis hele serialiseringen; ellers normaliseres alt.
  private chunkNormsFor(chunks: Block[][], info: SourceInfo): string[] {
    const src = this.source;
    const e0 = this.initial!;
    const texts = chunks.map((c) => src.slice(c[0].start, c[c.length - 1].end));
    if (info.refs || !chunks.length) return normalizeEach(texts, true);
    const anchors = anchorsOf(parseBlocks(e0).tokens);
    const map = matchBlocks(
      info.anchors.map((a) => a.type),
      anchors.map((a) => a.type)
    );
    const lines = splitLines(e0);
    const index = new Map<number, number>(); // kildelinje → første anker dér
    info.anchors.forEach((a, i) => index.has(a.line) || index.set(a.line, i));
    const firstAnchor = chunks.map((c) => index.get(c[0].line) ?? -1);
    firstAnchor.push(info.anchors.length);
    // hvor stykket starter i serialiseringen: anker og tegnindeks
    const at = firstAnchor.map((i, c) => {
      if (c === chunks.length) return { anchor: anchors.length, offset: e0.length };
      const j = i >= 0 ? map[i] : -1;
      const line = j >= 0 ? anchors[j].line : -1;
      if (line < 0 || (line > 0 && !lines[line - 1].blank)) return null;
      return { anchor: j, offset: lines[line].start };
    });
    const norms: (string | null)[] = chunks.map((_, c) => {
      const from = at[c];
      const to = at[c + 1];
      if (!from || !to || (c === 0) !== (from.offset === 0)) return null;
      const a0 = firstAnchor[c];
      const a1 = firstAnchor[c + 1];
      if (a0 < 0 || a1 < 0 || to.anchor - from.anchor !== a1 - a0) return null;
      for (let i = a0; i < a1; i++) if (map[i] !== from.anchor + (i - a0)) return null;
      return e0.slice(from.offset, to.offset).replace(/\n[ \t\n]*$/, "");
    });
    const missing = norms.flatMap((n, c) => (n === null ? [c] : []));
    const batch = normalizeEach(
      missing.map((c) => texts[c]),
      missing[0] === 0
    );
    missing.forEach((c, t) => (norms[c] = batch[t]));
    const out = norms as string[];
    return out.join("\n\n") === e0 ? out : normalizeEach(texts, true);
  }
}

// Deler et stykkes normaliserede tekst ud på dets blokke: hver blok efter
// den første skal starte med en blok eller et listepunkt øverst i noten
// (se anchorsOf), og de findes i samme rækkefølge i den normaliserede
// tekst. null = kan ikke deles.
function distribute(chunk: Block[], norm: string, info: SourceInfo): string[][] | null {
  if (!chunk.slice(1).every((b) => info.anchorLines.has(b.line))) return null;
  const last = chunk[chunk.length - 1];
  const srcAnchors = [...info.anchorLines]
    .filter((l) => l >= chunk[0].line && l <= last.endLine)
    .sort((a, b) => a - b);
  const normLines = anchorsOf(parseBlocks(norm).tokens).map((a) => a.line);
  const normAnchors = [...new Set(normLines)].sort((a, b) => a - b);
  if (normAnchors.length !== srcAnchors.length) return null;
  const lines = splitLines(norm);
  const offsets = [0];
  for (const b of chunk.slice(1)) {
    const line = normAnchors[srcAnchors.indexOf(b.line)];
    // ankeret skal starte en blok (efter en tom linje) i den normaliserede tekst
    if (!line || !lines[line - 1].blank || lines[line].start <= offsets[offsets.length - 1]) return null;
    offsets.push(lines[line].start);
  }
  const split = offsets.map((from, t) => blockTexts(norm.slice(from, offsets[t + 1] ?? norm.length)));
  if (split.some((p) => !p.length)) return null;
  return split;
}
