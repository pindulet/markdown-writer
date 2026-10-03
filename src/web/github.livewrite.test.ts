// Live-test af SKRIVNING mod en midlertidig gren i notes-repoet — aldrig main.
// Grenen laves fra main før testen og slettes bagefter, fx:
//   gh api -X POST repos/pindulet/notes/git/refs -f ref=refs/heads/mobil-test -f sha=<main-sha>
//   MW_LIVE_TOKEN=$(gh auth token) MW_LIVE_WRITE_BRANCH=mobil-test npx vitest run src/web/github.livewrite.test.ts
//   gh api -X DELETE repos/pindulet/notes/git/refs/heads/mobil-test
// Alt skrives i mappen _mobil-test/, så ingen rigtige noter røres.
import { describe, expect, it } from "vitest";
import { gitBlobSha } from "./blobSha";
import { createGitHubApi } from "./github";
import { createMemoryStore } from "./localStore";
import { createSyncEngine } from "./syncEngine";
import type { RemoteHead } from "./types";

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const token = env.MW_LIVE_TOKEN;
const branch = env.MW_LIVE_WRITE_BRANCH;
const enabled = Boolean(token && branch && branch !== "main");
const CFG = { owner: "pindulet", repo: "notes", branch: branch ?? "", token: token ?? "" };
const DIR = "_mobil-test";

describe.skipIf(!enabled)(`live: skrivning på grenen ${branch}`, () => {
  const api = createGitHubApi(CFG);
  const path = `${DIR}/Prøve æøå.md`;
  const content = "# Prøve\n\nHej æøå – fra skrivetesten.\r\nCRLF-linje\n";
  let before: RemoteHead;
  let after: string;

  it("commit lander, og træet har præcis den beregnede blob-sha", async () => {
    before = (await api.getHead(null))!.head;
    const res = await api.commit(before.commitSha, "Test (mobil): skrivetest", [{ path, content }], []);
    expect(res).not.toBe("stale");
    after = (res as { commitSha: string }).commitSha;
    const head = (await api.getHead(null))!.head;
    expect(head.commitSha).toBe(after);
    const entry = (await api.getTree(head.treeSha)).find((f) => f.path === path);
    expect(entry?.sha).toBe(await gitBlobSha(content));
    expect((await api.getBlobTexts([entry!.sha])).get(entry!.sha)).toBe(content);
  }, 60_000);

  it("forældet expectedHead giver 'stale'", async () => {
    const res = await api.commit(before.commitSha, "Test (mobil): skal afvises", [{ path, content: "x\n" }], []);
    expect(res).toBe("stale");
  }, 60_000);

  it("synkmotoren: første hentning, push af ny note, pull af ændring udefra, sletning", async () => {
    const store = createMemoryStore();
    const engine = createSyncEngine(store, api);
    const first = await engine.sync();
    expect(first).toMatchObject({ status: "ok", initial: true });

    // ny note på "telefonen"
    const mine = `${DIR}/Fra motoren.md`;
    await store.update(mine, () => ({ path: mine, sha: null, base: null, content: "Linje 1\n\nLinje 2\n", deleted: false, mtime: 0 }));
    expect(await engine.sync()).toMatchObject({ status: "ok", committed: 1 });

    // ændring "fra computeren" direkte på GitHub
    const head = (await api.getHead(null))!.head;
    const res = await api.commit(head.commitSha, "Test (desktop): ændring", [{ path: mine, content: "Linje 1\n\nLinje 2 – computeren\n" }], []);
    expect(res).not.toBe("stale");
    // samtidig lokal ændring i et andet afsnit
    await store.update(mine, (cur) => (cur ? { ...cur, content: "Linje 1 – telefonen\n\nLinje 2\n" } : undefined));
    const merged = await engine.sync();
    expect(merged.status).toBe("ok");
    expect((await store.get(mine))?.content).toBe("Linje 1 – telefonen\n\nLinje 2 – computeren\n");

    // sletning af begge testnoter
    for (const p of [mine, path]) {
      await store.update(p, (cur) => (cur ? { ...cur, deleted: true } : undefined));
    }
    expect(await engine.sync()).toMatchObject({ status: "ok", committed: 2 });
    const tree = await api.getTree((await api.getHead(null))!.head.treeSha);
    expect(tree.some((f) => f.path.startsWith(`${DIR}/`))).toBe(false);
  }, 180_000);
});
