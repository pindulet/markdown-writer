// Blok-diff til fremhævning af Claudes ændringer og til trevejsfletning:
// dokumentet deles i blokke (adskilt af tomme linjer, men aldrig inde i en
// ```/~~~-kodeblok), og LCS finder de blokke, der er tilføjet eller ændret.

export interface Block {
  text: string; // kildeteksten uden linjeskiftet efter sidste linje
  startLine: number; // 0-indekseret
  endLine: number;
}

interface RawBlock extends Block {
  start: number; // tegnposition i kilden
  sep: string; // præcis det mellemrum, der følger blokken (til næste blok eller slutningen)
}

interface Parsed {
  prefix: string; // tomme linjer før første blok (hele teksten, hvis der ingen blokke er)
  blocks: RawBlock[];
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

// Findes der en lukkelinje for hegnet efter position pos? Et hegn uden
// lukning (fx en kodeblok, man er ved at skrive) må ikke sluge resten af noten.
function hasFenceClose(md: string, pos: number, ch: string, len: number): boolean {
  for (const raw of md.slice(pos).split("\n")) {
    const m = FENCE_CLOSE.exec(raw.replace(/\r$/, ""));
    if (m && m[1][0] === ch && m[1].length >= len) return true;
  }
  return false;
}

function parse(md: string): Parsed {
  const blocks: RawBlock[] = [];
  let cur: { start: number; end: number; startLine: number; endLine: number } | null = null;
  let fence: { ch: string; len: number } | null = null;
  const close = () => {
    if (!cur) return;
    const { start, end, startLine, endLine } = cur;
    blocks.push({ text: md.slice(start, end), startLine, endLine, start, sep: "" });
    cur = null;
  };
  let pos = 0;
  for (let lineNo = 0; ; lineNo++) {
    const nl = md.indexOf("\n", pos);
    const lineEnd = nl === -1 ? md.length : nl;
    const contentEnd = lineEnd > pos && md[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;
    const line = md.slice(pos, contentEnd);
    if (!fence && line.trim() === "") {
      close();
    } else {
      if (cur) {
        cur.end = contentEnd;
        cur.endLine = lineNo;
      } else {
        cur = { start: pos, end: contentEnd, startLine: lineNo, endLine: lineNo };
      }
      if (fence) {
        const m = FENCE_CLOSE.exec(line);
        if (m && m[1][0] === fence.ch && m[1].length >= fence.len) fence = null;
      } else {
        const m = FENCE_OPEN.exec(line);
        // et ```-hegn må ikke have ` i info-strengen (så er det inline-kode)
        if (
          m &&
          !(m[1][0] === "`" && m[2].includes("`")) &&
          hasFenceClose(md, nl === -1 ? md.length : nl + 1, m[1][0], m[1].length)
        ) {
          fence = { ch: m[1][0], len: m[1].length };
        }
      }
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  close();
  // mellemrummet efter hver blok er alt frem til næste blok
  blocks.forEach((b, i) => {
    b.sep = md.slice(b.start + b.text.length, i + 1 < blocks.length ? blocks[i + 1].start : md.length);
  });
  return { prefix: blocks.length ? md.slice(0, blocks[0].start) : md, blocks };
}

export function splitBlocks(md: string): Block[] {
  return parse(md).blocks.map(({ text, startLine, endLine }) => ({ text, startLine, endLine }));
}

// Sammenligningsnøgle: CRLF/LF og omgivende mellemrum tæller ikke
const key = (s: string) => s.replace(/\r\n?/g, "\n").trim();

function lcsTable(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0)
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

// Indeks (i den nye version) på blokke, der ikke findes uændret i den gamle.
export function changedBlockIndices(prev: string, next: string): number[] {
  const a = splitBlocks(prev).map((b) => key(b.text));
  const b = splitBlocks(next).map((bl) => key(bl.text));
  const m = a.length;
  const n = b.length;
  const dp = lcsTable(a, b);
  const changed: number[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      changed.push(j);
      j++;
    }
  }
  while (j < n) {
    changed.push(j);
    j++;
  }
  return changed;
}

// For hver blok i a: indekset på dens uændrede makker i b, ellers -1.
// Matchene er strengt stigende (LCS), så de kan bruges som ankre.
function lcsMatch(a: string[], b: string[]): number[] {
  const dp = lcsTable(a, b);
  const map = new Array<number>(a.length).fill(-1);
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      map[i] = j;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return map;
}

// Trevejsvalg: det, der kun er ændret på den ene side, vinder; ellers min
const pick = (base: string, mine: string, theirs: string) =>
  mine === theirs ? mine : mine === base ? theirs : mine;

const sameKeys = (x: string[], y: string[]) => x.length === y.length && x.every((s, i) => s === y[i]);

// En blok i resultatet og dens plads i de versioner, den stammer fra
interface Item {
  text: string;
  b?: number;
  m?: number;
  t?: number;
}

// Én sides ændring inden for et segment: base-blokkene [b0, b1) er blevet til [s0, s1)
interface Hunk {
  side: "m" | "t";
  b0: number;
  b1: number;
  s0: number;
  s1: number;
}

function sideHunks(side: Hunk["side"], map: number[], b0: number, b1: number, s0: number, s1: number): Hunk[] {
  const out: Hunk[] = [];
  let b = b0;
  let s = s0;
  for (let i = b0; i < b1; i++) {
    const j = map[i];
    if (j === -1) continue; // ændret eller slettet på denne side
    if (b < i || s < j) out.push({ side, b0: b, b1: i, s0: s, s1: j });
    b = i + 1;
    s = j + 1;
  }
  if (b < b1 || s < s1) out.push({ side, b0: b, b1, s0: s, s1 });
  return out;
}

// Trevejs-fletning på blokniveau. Blokke, der kun er ændret i den ene
// version, tages derfra; er samme område ændret i begge, beholdes begge
// (min version først), så intet går tabt. Tomme linjer og linjeskift (CRLF)
// mellem blokkene tages fra den version, blokkene kommer fra, så urørte
// dele af noten forbliver byte for byte som før.
export function mergeThreeWay(base: string, mine: string, theirs: string): string {
  const B = parse(base);
  const M = parse(mine);
  const T = parse(theirs);
  const kb = B.blocks.map((b) => key(b.text));
  const km = M.blocks.map((b) => key(b.text));
  const kt = T.blocks.map((b) => key(b.text));
  const mapMine = lcsMatch(kb, km);
  const mapTheirs = lcsMatch(kb, kt);

  const items: Item[] = [];
  let pm = 0; // næste uforbrugte blok i mine
  let pt = 0; // næste uforbrugte blok i theirs
  let pb = 0; // første base-blok i det aktuelle segment

  const fromMine = (j0: number, j1: number) => {
    for (let j = j0; j < j1; j++) items.push({ text: M.blocks[j].text, m: j });
  };
  const fromTheirs = (j0: number, j1: number) => {
    for (let j = j0; j < j1; j++) items.push({ text: T.blocks[j].text, t: j });
  };

  // Mellem to ankre: hver sides ændringer for sig. Kun ændringer, der
  // overlapper i base (eller indsættelser samme sted fra begge sider),
  // er en konflikt; ellers tages hver ændring fra den side, der lavede den.
  const emitSegment = (mEnd: number, tEnd: number, bEnd: number) => {
    const hunks = [
      ...sideHunks("m", mapMine, pb, bEnd, pm, mEnd),
      ...sideHunks("t", mapTheirs, pb, bEnd, pt, tEnd),
    ].sort((x, y) => x.b0 - y.b0 || x.b1 - y.b1 || (x.side === "m" ? -1 : 1));
    const groups: Hunk[][] = [];
    let g0 = -1;
    let g1 = -1;
    for (const h of hunks) {
      const joins = groups.length > 0 && (h.b0 < g1 || (h.b0 === g1 && h.b0 === h.b1 && g0 === g1));
      if (joins) {
        groups[groups.length - 1].push(h);
        g1 = Math.max(g1, h.b1);
      } else {
        groups.push([h]);
        g0 = h.b0;
        g1 = h.b1;
      }
    }
    for (const group of groups) {
      const gm = group.filter((h) => h.side === "m");
      const gt = group.filter((h) => h.side === "t");
      if (!gt.length) {
        for (const h of gm) fromMine(h.s0, h.s1); // kun ændret af mig
        continue;
      }
      if (!gm.length) {
        for (const h of gt) fromTheirs(h.s0, h.s1); // kun ændret på den anden side
        continue;
      }
      // begge sider har ændret området: hver sides version af hele området
      const lo = group[0].b0;
      const hi = Math.max(...group.map((h) => h.b1));
      const span = (hs: Hunk[], map: number[]): [number, number] => {
        const first = hs[0];
        const last = hs[hs.length - 1];
        return [first.b0 === lo ? first.s0 : map[lo], last.b1 === hi ? last.s1 : map[hi - 1] + 1];
      };
      const [m0, m1] = span(gm, mapMine);
      const [t0, t1] = span(gt, mapTheirs);
      if (sameKeys(km.slice(m0, m1), kt.slice(t0, t1))) {
        for (let k = 0; k < m1 - m0; k++) items.push({ text: M.blocks[m0 + k].text, m: m0 + k, t: t0 + k });
      } else {
        fromMine(m0, m1); // ændret begge steder: behold begge, min først
        fromTheirs(t0, t1);
      }
    }
  };

  for (let i = 0; i < kb.length; i++) {
    const jm = mapMine[i];
    const jt = mapTheirs[i];
    if (jm === -1 || jt === -1) continue;
    // anker: blokken er uændret i begge versioner
    emitSegment(jm, jt, i);
    items.push({ text: pick(B.blocks[i].text, M.blocks[jm].text, T.blocks[jt].text), b: i, m: jm, t: jt });
    pm = jm + 1;
    pt = jt + 1;
    pb = i + 1;
  }
  emitSegment(km.length, kt.length, kb.length);

  const trail = (p: Parsed) => (p.blocks.length ? p.blocks[p.blocks.length - 1].sep : "");
  const prefix = pick(B.prefix, M.prefix, T.prefix);
  const trailing = pick(trail(B), trail(M), trail(T));
  if (!items.length) return prefix + trailing;

  // nye blokgrænser får notens egen linjeskiftstil
  const style = [mine, theirs, base].find((s) => s.includes("\n")) ?? "";
  const nl = style.includes("\r\n") ? "\r\n" : "\n";
  // et mellemrum mellem to blokke i samme version (aldrig det afsluttende)
  const gapAfter = (p: Parsed, j: number | undefined) =>
    j !== undefined && j + 1 < p.blocks.length ? p.blocks[j].sep : undefined;
  const gapBefore = (p: Parsed, j: number | undefined) =>
    j !== undefined && j > 0 ? p.blocks[j - 1].sep : undefined;
  const between = (a: Item, z: Item): string => {
    const viaM = a.m !== undefined && z.m === a.m + 1 ? M.blocks[a.m].sep : undefined;
    const viaT = a.t !== undefined && z.t === a.t + 1 ? T.blocks[a.t].sep : undefined;
    if (viaM !== undefined && viaT !== undefined) {
      const viaB = a.b !== undefined && z.b === a.b + 1 ? B.blocks[a.b].sep : undefined;
      return viaB !== undefined ? pick(viaB, viaM, viaT) : viaM;
    }
    return (
      viaM ??
      viaT ??
      gapAfter(M, a.m) ??
      gapAfter(T, a.t) ??
      gapBefore(M, z.m) ??
      gapBefore(T, z.t) ??
      nl + nl
    );
  };

  let out = prefix;
  items.forEach((item, k) => {
    out += item.text + (k + 1 < items.length ? between(item, items[k + 1]) : trailing);
  });
  return out;
}
