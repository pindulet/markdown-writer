// Blok-diff til fremhævning af Claudes ændringer: dokumentet deles i
// blokke (adskilt af tomme linjer), og LCS finder de blokke i den nye
// version, der er tilføjet eller ændret.

export interface Block {
  text: string;
  startLine: number; // 0-indekseret
  endLine: number;
}

export function splitBlocks(md: string): Block[] {
  const lines = md.split("\n");
  const blocks: Block[] = [];
  let current: string[] = [];
  let start = 0;
  lines.forEach((line, i) => {
    if (line.trim() === "") {
      if (current.length) {
        blocks.push({ text: current.join("\n"), startLine: start, endLine: i - 1 });
        current = [];
      }
    } else {
      if (!current.length) start = i;
      current.push(line);
    }
  });
  if (current.length) {
    blocks.push({ text: current.join("\n"), startLine: start, endLine: lines.length - 1 });
  }
  return blocks;
}

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
  const a = splitBlocks(prev).map((b) => b.text.trim());
  const b = splitBlocks(next).map((bl) => bl.text.trim());
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

// Trevejs-fletning på blokniveau. Blokke, der kun er ændret i den ene
// version, tages derfra; er samme område ændret i begge, beholdes begge
// (min version først), så intet går tabt.
export function mergeThreeWay(base: string, mine: string, theirs: string): string {
  const blocksBase = splitBlocks(base).map((b) => b.text);
  const blocksMine = splitBlocks(mine).map((b) => b.text);
  const blocksTheirs = splitBlocks(theirs).map((b) => b.text);
  const trimmed = (arr: string[]) => arr.map((s) => s.trim());
  const mapMine = lcsMatch(trimmed(blocksBase), trimmed(blocksMine));
  const mapTheirs = lcsMatch(trimmed(blocksBase), trimmed(blocksTheirs));

  const out: string[] = [];
  let pm = 0; // næste uforbrugte blok i mine
  let pt = 0; // næste uforbrugte blok i theirs
  const sameText = (x: string[], y: string[]) =>
    trimmed(x).join("\n\n") === trimmed(y).join("\n\n");

  const emitSegment = (mineSeg: string[], theirsSeg: string[], baseSeg: string[]) => {
    if (sameText(mineSeg, theirsSeg)) {
      out.push(...mineSeg);
    } else if (sameText(mineSeg, baseSeg)) {
      out.push(...theirsSeg); // kun ændret på disken
    } else if (sameText(theirsSeg, baseSeg)) {
      out.push(...mineSeg); // kun ændret af mig
    } else {
      out.push(...mineSeg, ...theirsSeg); // ændret begge steder: behold begge
    }
  };

  let baseSeg: string[] = [];
  for (let i = 0; i < blocksBase.length; i++) {
    if (mapMine[i] !== -1 && mapTheirs[i] !== -1) {
      // anker: blokken er uændret i begge versioner
      emitSegment(
        blocksMine.slice(pm, mapMine[i]),
        blocksTheirs.slice(pt, mapTheirs[i]),
        baseSeg
      );
      out.push(blocksMine[mapMine[i]]);
      pm = mapMine[i] + 1;
      pt = mapTheirs[i] + 1;
      baseSeg = [];
    } else {
      baseSeg.push(blocksBase[i]);
    }
  }
  emitSegment(blocksMine.slice(pm), blocksTheirs.slice(pt), baseSeg);

  const trailing = mine.endsWith("\n") || theirs.endsWith("\n") ? "\n" : "";
  return out.join("\n\n") + trailing;
}
