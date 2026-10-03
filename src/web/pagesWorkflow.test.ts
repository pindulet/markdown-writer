import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Udrulningen af mobilversionen skal ske i push-rækkefølge: to hurtige push
// må ikke ende med, at den ældre commit udrulles sidst. Det kræver, at hele
// kørslen (build + deploy) står i kø i samme gruppe, og at intet job står i
// kø i den samme gruppe som sin egen kørsel (deadlock).
const FILE = resolve(__dirname, "../../.github/workflows/pages.yml");
const source = readFileSync(FILE, "utf8");

// blok under en nøgle i kolonne 0: linjerne indtil næste nøgle i kolonne 0
function topLevelBlock(key: string): string[] | null {
  const lines = source.split("\n");
  const start = lines.findIndex((l) => l === `${key}:` || l.startsWith(`${key}: `));
  if (start < 0) return null;
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    if (line.trim() && !line.trim().startsWith("#")) block.push(line.trim());
  }
  return block;
}

function hasRuby(): boolean {
  try {
    execFileSync("ruby", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("GitHub Pages-workflowet", () => {
  it("serialiserer hele kørsler i gruppen pages uden at afbryde en igangværende", () => {
    const block = topLevelBlock("concurrency");
    expect(block).not.toBeNull();
    expect(block).toContain("group: pages");
    expect(block).toContain("cancel-in-progress: false");
  });

  it("har ingen concurrency på jobniveau (samme gruppe ville vente på sig selv)", () => {
    const nested = source
      .split("\n")
      .filter((l) => /^\s+concurrency:/.test(l) && !l.trim().startsWith("#"));
    expect(nested).toEqual([]);
  });

  // fuld YAML-kontrol, hvor ruby findes (macOS og GitHubs ubuntu-runnere)
  it.skipIf(!hasRuby())("er gyldig YAML med den forventede struktur", () => {
    const json = execFileSync(
      "ruby",
      ["-ryaml", "-rjson", "-e", "puts JSON.generate(YAML.safe_load(File.read(ARGV[0])))", FILE],
      { encoding: "utf8" }
    );
    const wf = JSON.parse(json);
    expect(wf.concurrency).toEqual({ group: "pages", "cancel-in-progress": false });
    expect(Object.keys(wf.jobs)).toEqual(["build", "deploy"]);
    expect(wf.jobs.deploy.needs).toBe("build");
    for (const job of Object.values<Record<string, unknown>>(wf.jobs)) {
      expect(job.concurrency).toBeUndefined();
    }
    expect(wf.jobs.deploy.permissions).toEqual({ pages: "write", "id-token": "write" });
  });
});
