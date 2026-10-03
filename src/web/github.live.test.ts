// Live-test mod det rigtige notes-repo — KUN læsning, aldrig commit.
// Køres kun med en nøgle i miljøet:
//   MW_LIVE_TOKEN=$(gh auth token) npx vitest run src/web/github.live.test.ts
import { describe, expect, it } from "vitest";
import { gitBlobSha } from "./blobSha";
import { createGitHubApi } from "./github";
import { isNoteFile } from "./syncEngine";
import type { RemoteFile, RemoteHead } from "./types";

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const token = env.MW_LIVE_TOKEN;
const CFG = { owner: "pindulet", repo: "notes", branch: "main", token: token ?? "" };

const counts = { graphql: 0, rest: 0, other: 0 };

// Værn: alt andet end GET og GraphQL-forespørgsler (query) afvises, før det når GitHub
const readOnlyFetch: typeof fetch = (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  const method = (init.method ?? "GET").toUpperCase();
  const isGraphql = url === "https://api.github.com/graphql";
  if (method !== "GET" && !(isGraphql && method === "POST" && !/\bmutation\b/.test(String(init.body)))) {
    throw new Error(`live-testen må kun læse (${method} ${url})`);
  }
  if (isGraphql) counts.graphql++;
  else if (url.includes("/git/blobs/")) counts.rest++;
  else counts.other++;
  return fetch(input, init);
};

describe.skipIf(!token)("live: pindulet/notes (kun læsning)", () => {
  const api = createGitHubApi(CFG, readOnlyFetch);
  let head: RemoteHead;
  let notes: RemoteFile[] = [];

  it("getHead, og 304 når ETag'en sendes igen", async () => {
    const t0 = Date.now();
    const res = await api.getHead(null);
    expect(res).not.toBeNull();
    head = res!.head;
    expect(head.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(head.treeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(res!.etag).toBeTruthy();
    expect(await api.getHead(res!.etag)).toBeNull();
    console.log(`[live] head ${head.commitSha.slice(0, 7)}, tree ${head.treeSha.slice(0, 7)} (${Date.now() - t0} ms)`);
  }, 30_000);

  it("getTree: tæller noterne som desktopens collect_md", async () => {
    const t0 = Date.now();
    const files = await api.getTree(head.treeSha);
    notes = files.filter((f) => isNoteFile(f.path));
    console.log(`[live] træ: ${files.length} blobs, ${notes.length} noter (${Date.now() - t0} ms)`);
    expect(notes.length).toBeGreaterThan(700);
    expect(notes.length).toBeLessThan(900);
    expect(files.some((f) => f.path.includes(".fuse_hidden"))).toBe(true);
    expect(notes.some((f) => f.path.includes(".fuse_hidden"))).toBe(false);
  }, 30_000);

  it("getBlobTexts henter ALLE noter, og hver tekst har præcis sin blob-sha", async () => {
    const t0 = Date.now();
    counts.graphql = 0;
    counts.rest = 0;
    const progress: [number, number][] = [];
    const texts = await api.getBlobTexts(
      notes.map((f) => f.sha),
      (d, t) => progress.push([d, t])
    );
    const unique = new Set(notes.map((f) => f.sha)).size;
    expect(texts.size).toBe(unique);
    let bytes = 0;
    let mismatches = 0;
    for (const f of notes) {
      const text = texts.get(f.sha);
      expect(text).toBeDefined();
      bytes += new TextEncoder().encode(text!).length;
      if ((await gitBlobSha(text!)) !== f.sha) mismatches++;
    }
    expect(mismatches).toBe(0);
    expect(progress.at(-1)).toEqual([unique, unique]);
    console.log(
      `[live] ${texts.size} noter, ${(bytes / 1e6).toFixed(2)} MB, ${counts.graphql} GraphQL-kald, ` +
        `${counts.rest} REST-blobs, ${progress.length} fremdriftsopdateringer (${Date.now() - t0} ms)`
    );
  }, 180_000);

  it("REST-fallback: GraphQL afvist (403) → blobs hentes enkeltvis og valideres", async () => {
    const sample = notes.slice(0, 3);
    const blocked: typeof fetch = async (input, init) => {
      if (String(input) === "https://api.github.com/graphql") {
        return new Response(JSON.stringify({ message: "Resource not accessible" }), { status: 403 });
      }
      return readOnlyFetch(input, init);
    };
    const t0 = Date.now();
    counts.rest = 0;
    const texts = await createGitHubApi(CFG, blocked).getBlobTexts(sample.map((f) => f.sha));
    for (const f of sample) expect(await gitBlobSha(texts.get(f.sha)!)).toBe(f.sha);
    expect(counts.rest).toBe(new Set(sample.map((f) => f.sha)).size);
    console.log(`[live] REST-fallback (403): ${sample.length} blobs (${Date.now() - t0} ms)`);
  }, 30_000);

  it("REST-fallback: en GraphQL-tekst, der ikke passer med sin sha, hentes igen over REST", async () => {
    const sample = notes.slice(3, 6);
    const tampered: typeof fetch = async (input, init) => {
      const res = await readOnlyFetch(input, init);
      if (String(input) !== "https://api.github.com/graphql") return res;
      const body = (await res.json()) as { data: { repository: Record<string, { text: string }> } };
      body.data.repository.b0.text += " (forvansket)";
      return new Response(JSON.stringify(body), { status: res.status });
    };
    counts.rest = 0;
    const texts = await createGitHubApi(CFG, tampered).getBlobTexts(sample.map((f) => f.sha));
    for (const f of sample) expect(await gitBlobSha(texts.get(f.sha)!)).toBe(f.sha);
    expect(counts.rest).toBe(1);
  }, 30_000);
});
