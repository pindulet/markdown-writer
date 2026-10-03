import { describe, expect, it } from "vitest";
import { gitBlobSha, utf8ToBase64 } from "./blobSha";
import { createGitHubApi, verifyConnection } from "./github";
import { GitHubError } from "./types";

const TOKEN = "falsk-testnoegle-HEMMELIG-123";
const CFG = { owner: "pindulet", repo: "notes", branch: "main", token: TOKEN };

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  cache?: RequestCache;
}

type Handler = (call: Call) => Response | Promise<Response>;

function mockFetch(handler: Handler) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call: Call = {
      url: new URL(String(input)),
      method: init.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)),
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      cache: init.cache,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const SHA_A = "a".repeat(40);
const SHA_T = "b".repeat(40);

async function caught(p: Promise<unknown>): Promise<GitHubError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(GitHubError);
    expect((e as Error).message).not.toContain(TOKEN);
    return e as GitHubError;
  }
  throw new Error("forventede en fejl");
}

// GraphQL-svar for blob-forespørgsler: oid → node (eller null)
function blobQueryHandler(nodes: (oid: string) => unknown) {
  return (call: Call) => {
    const vars = (call.body as { variables: Record<string, string> }).variables;
    const repository: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(vars)) if (/^o\d+$/.test(k)) repository[`b${k.slice(1)}`] = nodes(v);
    return json({ data: { repository } });
  };
}

describe("blobSha", () => {
  it("giver samme sha som git hash-object", async () => {
    expect(await gitBlobSha("")).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    expect(await gitBlobSha("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    // BOM + CRLF + æøå tælles som UTF-8-bytes
    expect(await gitBlobSha("﻿# Titel\r\nø\r\n")).toBe("8131cb1f0cc7c59f306f5dac76de183f46947aee");
  });

  it("base64 af UTF-8 med korrekt padding", () => {
    expect(utf8ToBase64("")).toBe("");
    expect(utf8ToBase64("a")).toBe("YQ==");
    expect(utf8ToBase64("ab")).toBe("YWI=");
    expect(utf8ToBase64("abc")).toBe("YWJj");
    expect(utf8ToBase64("æøå")).toBe("w6bDuMOl");
    const big = "Møde ".repeat(40_000);
    const bytes = Uint8Array.from(atob(utf8ToBase64(big)), (c) => c.charCodeAt(0));
    expect(new TextDecoder().decode(bytes)).toBe(big);
  });
});

describe("getHead", () => {
  it("bruger sha-mediatypen, no-store og If-None-Match; 304 = uændret", async () => {
    const { fetchImpl, calls } = mockFetch(() => new Response(null, { status: 304 }));
    const api = createGitHubApi(CFG, fetchImpl);
    expect(await api.getHead('"etag-1"')).toBeNull();
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c.url.toString()).toBe("https://api.github.com/repos/pindulet/notes/commits/main");
    expect(c.cache).toBe("no-store");
    expect(c.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github.sha",
      "X-GitHub-Api-Version": "2022-11-28",
      "If-None-Match": '"etag-1"',
    });
  });

  it("ved ændring: slår commit'et op for at få træet", async () => {
    const { fetchImpl, calls } = mockFetch((call) => {
      if (call.url.pathname.endsWith("/commits/main")) {
        return new Response(SHA_A + "\n", { status: 200, headers: { etag: '"ny-etag"' } });
      }
      if (call.url.pathname === `/repos/pindulet/notes/git/commits/${SHA_A}`) {
        return json({ sha: SHA_A, tree: { sha: SHA_T } });
      }
      return json({ message: "Not Found" }, 404);
    });
    const res = await createGitHubApi(CFG, fetchImpl).getHead(null);
    expect(res).toEqual({ head: { commitSha: SHA_A, treeSha: SHA_T }, etag: '"ny-etag"' });
    expect(calls[0].headers["If-None-Match"]).toBeUndefined();
  });

  it("branch-navne med skråstreg og specialtegn indkodes pr. segment", async () => {
    const { fetchImpl, calls } = mockFetch(() => new Response(null, { status: 304 }));
    await createGitHubApi({ ...CFG, branch: "mobil/æ ø" }, fetchImpl).getHead("x");
    expect(calls[0].url.pathname).toBe("/repos/pindulet/notes/commits/mobil/%C3%A6%20%C3%B8");
  });
});

describe("getTree", () => {
  it("returnerer kun almindelige blobs", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      json({
        sha: SHA_T,
        truncated: false,
        tree: [
          { path: "Mappe", mode: "040000", type: "tree", sha: "1".repeat(40) },
          { path: "Mappe/Møde.md", mode: "100644", type: "blob", sha: "2".repeat(40), size: 12 },
          { path: "link.md", mode: "120000", type: "blob", sha: "3".repeat(40), size: 5 },
          { path: "sub", mode: "160000", type: "commit", sha: "4".repeat(40) },
          { path: "run.sh", mode: "100755", type: "blob", sha: "5".repeat(40), size: 3 },
        ],
      })
    );
    const files = await createGitHubApi(CFG, fetchImpl).getTree(SHA_T);
    expect(files).toEqual([
      { path: "Mappe/Møde.md", sha: "2".repeat(40), size: 12 },
      { path: "run.sh", sha: "5".repeat(40), size: 3 },
    ]);
    expect(calls[0].url.pathname + calls[0].url.search).toBe(
      `/repos/pindulet/notes/git/trees/${SHA_T}?recursive=1`
    );
  });

  it("kaster, hvis GitHub trunkerer træet", async () => {
    const { fetchImpl } = mockFetch(() => json({ sha: SHA_T, truncated: true, tree: [] }));
    const err = await caught(createGitHubApi(CFG, fetchImpl).getTree(SHA_T));
    expect(err.kind).toBe("other");
  });
});

describe("getBlobTexts", () => {
  it("henter via GraphQL, validerer sha'en og falder tilbage til REST for resten", async () => {
    const texts = ["# Én\n", "to\r\n", "tre æøå\n", "fire\n", "fem\n"];
    const shas = await Promise.all(texts.map(gitBlobSha));
    const bySha = new Map(shas.map((s, i) => [s, texts[i]]));
    const progress: [number, number][] = [];
    const { fetchImpl, calls } = mockFetch(async (call) => {
      if (call.url.pathname === "/graphql") {
        return blobQueryHandler((oid) => {
          if (oid === shas[1]) return { text: "forkert tekst", isBinary: false, isTruncated: false }; // sha passer ikke
          if (oid === shas[2]) return { text: "", isBinary: false, isTruncated: true };
          if (oid === shas[3]) return null;
          return { text: bySha.get(oid), isBinary: false, isTruncated: false };
        })(call);
      }
      const sha = call.url.pathname.split("/").pop()!;
      return new Response(new TextEncoder().encode(bySha.get(sha)!), { status: 200 });
    });
    const out = await createGitHubApi(CFG, fetchImpl).getBlobTexts([...shas, shas[0]], (d, t) =>
      progress.push([d, t])
    );
    expect(out.size).toBe(5);
    shas.forEach((s, i) => expect(out.get(s)).toBe(texts[i]));
    const gql = calls.filter((c) => c.url.pathname === "/graphql");
    expect(gql).toHaveLength(1);
    expect(gql[0].cache).toBe("no-store");
    const rest = calls.filter((c) => c.url.pathname.includes("/git/blobs/"));
    expect(rest.map((c) => c.url.pathname.split("/").pop()).sort()).toEqual([shas[1], shas[2], shas[3]].sort());
    expect(rest[0].headers.Accept).toBe("application/vnd.github.raw+json");
    expect(progress[0]).toEqual([0, 5]);
    expect(progress.at(-1)).toEqual([5, 5]);
  });

  it("REST bevarer BOM'en byte for byte", async () => {
    const text = "﻿hej\r\n";
    const sha = await gitBlobSha(text);
    const { fetchImpl } = mockFetch((call) =>
      call.url.pathname === "/graphql"
        ? json({ data: { repository: { b0: null } } })
        : new Response(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x65, 0x6a, 0x0d, 0x0a]), { status: 200 })
    );
    const out = await createGitHubApi(CFG, fetchImpl).getBlobTexts([sha]);
    expect(out.get(sha)).toBe(text);
  });

  it("GraphQL-fejl med HTTP 200 og errors[] → alt over REST", async () => {
    const text = "x\n";
    const sha = await gitBlobSha(text);
    const { fetchImpl, calls } = mockFetch((call) =>
      call.url.pathname === "/graphql"
        ? json({ data: null, errors: [{ type: "SOMETHING", message: "Noget gik galt" }] })
        : new Response(text, { status: 200 })
    );
    expect((await createGitHubApi(CFG, fetchImpl).getBlobTexts([sha])).get(sha)).toBe(text);
    expect(calls.filter((c) => c.url.pathname.includes("/git/blobs/"))).toHaveLength(1);
  });

  it("GraphQL afvist med 403 → REST for alt, også i senere kald", async () => {
    const texts = ["a\n", "b\n"];
    const shas = await Promise.all(texts.map(gitBlobSha));
    const { fetchImpl, calls } = mockFetch((call) =>
      call.url.pathname === "/graphql"
        ? json({ message: "Resource not accessible by personal access token" }, 403)
        : new Response(texts[shas.indexOf(call.url.pathname.split("/").pop()!)], { status: 200 })
    );
    const api = createGitHubApi(CFG, fetchImpl);
    expect((await api.getBlobTexts([shas[0]])).get(shas[0])).toBe("a\n");
    expect((await api.getBlobTexts([shas[1]])).get(shas[1])).toBe("b\n");
    expect(calls.filter((c) => c.url.pathname === "/graphql")).toHaveLength(1);
  });

  it("GraphQL 502 → batchen hentes over REST, men GraphQL bruges stadig næste gang", async () => {
    const text = "y\n";
    const sha = await gitBlobSha(text);
    let gqlCalls = 0;
    const { fetchImpl } = mockFetch((call) => {
      if (call.url.pathname !== "/graphql") return new Response(text, { status: 200 });
      gqlCalls++;
      return gqlCalls === 1
        ? json({ message: "Bad Gateway" }, 502)
        : json({ data: { repository: { b0: { text, isBinary: false, isTruncated: false } } } });
    });
    const api = createGitHubApi(CFG, fetchImpl);
    expect((await api.getBlobTexts([sha])).get(sha)).toBe(text);
    expect((await api.getBlobTexts([sha])).get(sha)).toBe(text);
    expect(gqlCalls).toBe(2);
  });

  it("rate-limit på GraphQL kastes videre i stedet for at hamre løs på REST", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      json({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0" })
    );
    const err = await caught(createGitHubApi(CFG, fetchImpl).getBlobTexts(["c".repeat(40)]));
    expect(err.kind).toBe("rate-limit");
    expect(calls).toHaveLength(1);
  });

  it("deler i batches af højst 100 og henter højst 6 REST-blobs ad gangen", async () => {
    const shas = Array.from({ length: 250 }, (_, i) => i.toString(16).padStart(40, "0"));
    let active = 0;
    let maxActive = 0;
    const { fetchImpl, calls } = mockFetch(async (call) => {
      if (call.url.pathname === "/graphql") return blobQueryHandler(() => null)(call);
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 1));
      active--;
      return new Response("tekst", { status: 200 });
    });
    const out = await createGitHubApi(CFG, fetchImpl).getBlobTexts(shas);
    expect(out.size).toBe(250);
    const gql = calls.filter((c) => c.url.pathname === "/graphql");
    expect(gql).toHaveLength(3);
    for (const c of gql) {
      const n = Object.keys((c.body as { variables: object }).variables).filter((k) => /^o\d+$/.test(k)).length;
      expect(n).toBeLessThanOrEqual(100);
    }
    expect(maxActive).toBeLessThanOrEqual(6);
    expect(maxActive).toBeGreaterThan(1);
  });

  it("en blob, der ikke kan hentes, får hele kaldet til at fejle", async () => {
    const { fetchImpl } = mockFetch((call) =>
      call.url.pathname === "/graphql" ? json({ data: { repository: { b0: null } } }) : json({ message: "Not Found" }, 404)
    );
    const err = await caught(createGitHubApi(CFG, fetchImpl).getBlobTexts(["d".repeat(40)]));
    expect(err.kind).toBe("not-found");
  });
});

describe("commit", () => {
  it("sender ét createCommitOnBranch med expectedHeadOid og base64 af UTF-8", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      json({ data: { createCommitOnBranch: { commit: { oid: SHA_A, tree: { oid: SHA_T } } } } })
    );
    const res = await createGitHubApi(CFG, fetchImpl).commit(
      "f".repeat(40),
      "Noter (mobil): Møde",
      [{ path: "Indbakke/Møde på Ærø.md", content: "Æblegrød og øl — på Ærø\r\n" }],
      ["Gammel.md"]
    );
    expect(res).toEqual({ commitSha: SHA_A, treeSha: SHA_T });
    const c = calls[0];
    expect(c.url.pathname).toBe("/graphql");
    expect(c.method).toBe("POST");
    const body = c.body as { query: string; variables: { input: Record<string, any> } };
    expect(body.query).toContain("createCommitOnBranch");
    const input = body.variables.input;
    expect(input.branch).toEqual({ repositoryNameWithOwner: "pindulet/notes", branchName: "main" });
    expect(input.expectedHeadOid).toBe("f".repeat(40));
    expect(input.message).toEqual({ headline: "Noter (mobil): Møde" });
    expect(input.fileChanges.deletions).toEqual([{ path: "Gammel.md" }]);
    const add = input.fileChanges.additions[0];
    expect(add.path).toBe("Indbakke/Møde på Ærø.md");
    const bytes = Uint8Array.from(atob(add.contents), (ch) => ch.charCodeAt(0));
    expect(new TextDecoder().decode(bytes)).toBe("Æblegrød og øl — på Ærø\r\n");
  });

  it("'Expected branch to point to' (HTTP 200 med errors[]) → stale", async () => {
    const { fetchImpl } = mockFetch(() =>
      json({
        data: { createCommitOnBranch: null },
        errors: [
          {
            type: "UNPROCESSABLE",
            message: `Expected branch to point to "${"f".repeat(40)}" but it did not. Pull and try again.`,
          },
        ],
      })
    );
    expect(await createGitHubApi(CFG, fetchImpl).commit("f".repeat(40), "m", [], ["x.md"])).toBe("stale");
  });

  it("FORBIDDEN / 'Resource not accessible' → forbidden", async () => {
    for (const errors of [
      [{ type: "FORBIDDEN", message: "Resource not accessible by personal access token" }],
      [{ message: "Resource not accessible by personal access token" }],
    ]) {
      const { fetchImpl } = mockFetch(() => json({ data: { createCommitOnBranch: null }, errors }));
      const err = await caught(createGitHubApi(CFG, fetchImpl).commit("f".repeat(40), "m", [], ["x.md"]));
      expect(err.kind).toBe("forbidden");
    }
  });

  it("andre GraphQL-fejl → other med GitHubs besked", async () => {
    const { fetchImpl } = mockFetch(() =>
      json({ errors: [{ type: "UNPROCESSABLE", message: "A path was requested for deletion which does not exist" }] })
    );
    const err = await caught(createGitHubApi(CFG, fetchImpl).commit("f".repeat(40), "m", [], ["x.md"]));
    expect(err.kind).toBe("other");
    expect(err.message).toMatch(/does not exist/);
  });
});

describe("fejlklassifikation", () => {
  const cases: [string, () => Response, string][] = [
    ["401", () => json({ message: "Bad credentials" }, 401), "auth"],
    ["403 uden rate-limit", () => json({ message: "Resource not accessible" }, 403), "forbidden"],
    [
      "403 med x-ratelimit-remaining: 0",
      () => json({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0" }),
      "rate-limit",
    ],
    ["403 med retry-after", () => json({ message: "secondary" }, 403, { "retry-after": "60" }), "rate-limit"],
    ["429", () => json({ message: "Too many" }, 429), "rate-limit"],
    ["404", () => json({ message: "Not Found" }, 404), "not-found"],
    ["500", () => json({ message: "Server Error" }, 500), "other"],
    ["502 uden JSON", () => new Response("<html>bad gateway</html>", { status: 502 }), "other"],
  ];
  for (const [name, make, kind] of cases) {
    it(`${name} → ${kind}`, async () => {
      const { fetchImpl } = mockFetch(make);
      const err = await caught(createGitHubApi(CFG, fetchImpl).getTree(SHA_T));
      expect(err.kind).toBe(kind);
    });
  }

  it("netværksfejl (TypeError fra fetch) → offline", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    const err = await caught(createGitHubApi(CFG, fetchImpl).getHead(null));
    expect(err.kind).toBe("offline");
  });

  it("tidsgrænse (TimeoutError) → offline", async () => {
    const fetchImpl = (async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as typeof fetch;
    expect((await caught(createGitHubApi(CFG, fetchImpl).getHead(null))).kind).toBe("offline");
  });

  it("nøglen kommer aldrig med i fejlbeskeden, heller ikke hvis GitHub sender den tilbage", async () => {
    const { fetchImpl } = mockFetch(() => json({ message: `Token ${TOKEN} er ugyldig` }, 422));
    const err = await caught(createGitHubApi(CFG, fetchImpl).getTree(SHA_T));
    expect(err.message).not.toContain(TOKEN);
    const gql = mockFetch(() => json({ errors: [{ message: `bad ${TOKEN}` }] }));
    await caught(createGitHubApi(CFG, gql.fetchImpl).commit("f".repeat(40), "m", [], ["x.md"]));
  });
});

describe("verifyConnection", () => {
  it("GET /repos/{o}/{r} uden cache; ok = ingen fejl", async () => {
    const { fetchImpl, calls } = mockFetch(() => json({ full_name: "pindulet/notes" }));
    await expect(verifyConnection(CFG, fetchImpl)).resolves.toBeUndefined();
    expect(calls[0].url.toString()).toBe("https://api.github.com/repos/pindulet/notes");
    expect(calls[0].cache).toBe("no-store");
    expect(calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("401 → auth, 404 → not-found, intet net → offline", async () => {
    expect((await caught(verifyConnection(CFG, mockFetch(() => json({}, 401)).fetchImpl))).kind).toBe("auth");
    expect((await caught(verifyConnection(CFG, mockFetch(() => json({}, 404)).fetchImpl))).kind).toBe("not-found");
    const down = (async () => {
      throw new TypeError("Load failed");
    }) as typeof fetch;
    expect((await caught(verifyConnection(CFG, down))).kind).toBe("offline");
  });

  it("tjekker også branchen (med / i navnet): findes den ikke, siges det med navn", async () => {
    const cfg = { ...CFG, branch: "noter/mobil" };
    const ok = mockFetch(() => json({}));
    await verifyConnection(cfg, ok.fetchImpl);
    expect(ok.calls.map((c) => c.url.pathname)).toEqual([
      "/repos/pindulet/notes",
      "/repos/pindulet/notes/branches/noter/mobil",
    ]);
    expect(ok.calls[1].cache).toBe("no-store");

    const missing = mockFetch((call) =>
      call.url.pathname.includes("/branches/") ? json({ message: "Branch not found" }, 404) : json({})
    );
    const err = await caught(verifyConnection({ ...CFG, branch: "mian" }, missing.fetchImpl));
    expect(err.kind).toBe("not-found");
    expect(err.message).toBe("Branchen mian findes ikke i pindulet/notes");
  });
});

describe("ukendt branch efter opsætningen", () => {
  it("422 'No commit found' fra head-opslaget bliver til not-found (dansk tekst i synken)", async () => {
    const { fetchImpl } = mockFetch(() => json({ message: "No commit found for SHA: mian" }, 422));
    const err = await caught(createGitHubApi({ ...CFG, branch: "mian" }, fetchImpl).getHead(null));
    expect(err.kind).toBe("not-found");
    // andre 422'ere er stadig 'other'
    const other = mockFetch(() => json({ message: "Validation Failed" }, 422));
    expect((await caught(createGitHubApi(CFG, other.fetchImpl).getTree(SHA_T))).kind).toBe("other");
  });
});
