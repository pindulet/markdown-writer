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

// Indeks (i den nye version) på blokke, der ikke findes uændret i den gamle.
export function changedBlockIndices(prev: string, next: string): number[] {
  const a = splitBlocks(prev).map((b) => b.text.trim());
  const b = splitBlocks(next).map((bl) => bl.text.trim());
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
