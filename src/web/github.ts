// GitHub-klienten for webudgaven: læser via REST + GraphQL og skriver med
// ét atomisk GraphQL-commit (createCommitOnBranch). Alle fejl bliver til
// GitHubError med en art, som synk-motoren og opsætningsskærmen kan vise.
import { gitBlobSha, utf8ToBase64 } from "./blobSha";
import {
  GitHubError,
  type CommitResult,
  type FileAddition,
  type GitHubApi,
  type GitHubConfig,
  type ProgressFn,
  type RemoteFile,
} from "./types";

type Cfg = Pick<GitHubConfig, "owner" | "repo" | "branch" | "token">;

const API = "https://api.github.com";
const GRAPHQL_BATCH = 100; // aliaser pr. GraphQL-kald
const GRAPHQL_PARALLEL = 3;
const REST_PARALLEL = 6;
const REQUEST_TIMEOUT_MS = 60_000;

interface RequestOpts {
  method?: string;
  accept?: string;
  body?: string;
  // indholdsadresserede svar (træer og blobs efter sha) må gerne caches
  cache?: RequestCache;
  headers?: Record<string, string>;
}

interface GraphQLError {
  type?: string;
  message?: string;
}

interface BlobNode {
  text?: string | null;
  isBinary?: boolean;
  isTruncated?: boolean;
}

function offline(): GitHubError {
  return new GitHubError("offline", "Ingen forbindelse til GitHub");
}

function browserOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

// fetch afvist (intet net, CORS) eller afbrudt af vores tidsgrænse
function networkFailure(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  return e instanceof TypeError || name === "TimeoutError" || name === "AbortError";
}

// Hænger et kald (fx på et dårligt mobilnet), må synk-låsen ikke sidde fast for evigt
function timeoutSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
    ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    : undefined;
}

// Læser et svar; afbrudt forbindelse undervejs = offline, ulæseligt svar = other
async function readBody<T>(res: Response, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (e) {
    if (networkFailure(e)) throw offline();
    throw new GitHubError("other", "Uventet svar fra GitHub", res.status);
  }
}

// Kører fn over items med højst `limit` ad gangen; stopper ved første fejl
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function createClient(cfg: Cfg, fetchImpl: typeof fetch) {
  const repoPath = `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`;
  // "noter/mobil" må ikke blive til "noter%2Fmobil"
  const branchPath = cfg.branch.split("/").map(encodeURIComponent).join("/");

  // nøglen må aldrig ende i en fejlbesked, heller ikke via et ekko fra GitHub
  const scrub = (text: string) =>
    (cfg.token ? text.split(cfg.token).join("***") : text).slice(0, 300);

  async function request(path: string, opts: RequestOpts = {}): Promise<Response> {
    if (browserOffline()) throw offline();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${cfg.token}`,
      Accept: opts.accept ?? "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...opts.headers,
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    try {
      return await fetchImpl(API + path, {
        method: opts.method ?? "GET",
        headers,
        body: opts.body,
        cache: opts.cache ?? "default",
        signal: timeoutSignal(),
      });
    } catch (e) {
      if (networkFailure(e)) throw offline();
      const name = e instanceof Error ? e.message || e.name : String(e);
      throw new GitHubError("other", scrub(`Kaldet til GitHub fejlede: ${name}`));
    }
  }

  async function responseError(res: Response): Promise<GitHubError> {
    let msg = "";
    try {
      const body = (await res.json()) as { message?: unknown };
      if (typeof body?.message === "string") msg = body.message;
    } catch {
      // intet læsbart svar
    }
    const s = res.status;
    const limited =
      s === 429 ||
      (s === 403 &&
        (res.headers.get("x-ratelimit-remaining") === "0" ||
          res.headers.has("retry-after") ||
          /rate limit/i.test(msg)));
    if (s === 401) return new GitHubError("auth", "GitHub afviste adgangsnøglen", s);
    if (limited) return new GitHubError("rate-limit", "GitHub beder os vente lidt", s);
    if (s === 403) {
      return new GitHubError("forbidden", scrub(`Nøglen har ikke adgang${msg ? `: ${msg}` : ""}`), s);
    }
    // en ukendt branch giver 422 "No commit found for SHA: <branch>" på commits-opslaget
    if (s === 404 || (s === 422 && /no commit found/i.test(msg))) {
      return new GitHubError("not-found", "Repoet eller branchen blev ikke fundet", s);
    }
    return new GitHubError("other", scrub(`GitHub svarede ${s}${msg ? `: ${msg}` : ""}`), s);
  }

  async function getJson<T>(path: string, opts: RequestOpts = {}): Promise<T> {
    const res = await request(path, opts);
    if (!res.ok) throw await responseError(res);
    return readBody(res, () => res.json() as Promise<T>);
  }

  function graphqlError(errors: GraphQLError[]): GitHubError {
    const types = errors.map((e) => e.type ?? "");
    const text = errors.map((e) => e.message ?? "").join("; ");
    if (types.includes("RATE_LIMITED") || /rate limit/i.test(text)) {
      return new GitHubError("rate-limit", "GitHub beder os vente lidt");
    }
    if (types.includes("FORBIDDEN") || /not accessible|permission|push access/i.test(text)) {
      return new GitHubError("forbidden", scrub(`Nøglen har ikke adgang: ${text}`));
    }
    if (types.includes("NOT_FOUND")) {
      return new GitHubError("not-found", scrub(`Ikke fundet på GitHub: ${text}`));
    }
    return new GitHubError("other", scrub(`GitHub afviste kaldet: ${text || "ukendt fejl"}`));
  }

  // GraphQL svarer med HTTP 200 og errors[] ved de fleste fejl — tjek altid begge
  async function graphql<T>(
    query: string,
    variables: Record<string, unknown>
  ): Promise<{ res: Response; data?: T; errors?: GraphQLError[] }> {
    const res = await request("/graphql", {
      method: "POST",
      body: JSON.stringify({ query, variables }),
      cache: "no-store",
    });
    if (!res.ok) return { res };
    const body = await readBody(res, () => res.json() as Promise<{ data?: T; errors?: GraphQLError[] }>);
    return { res, data: body?.data ?? undefined, errors: body?.errors?.length ? body.errors : undefined };
  }

  return { repoPath, branchPath, request, responseError, getJson, graphql, graphqlError };
}

export function createGitHubApi(cfg: Cfg, fetchImpl: typeof fetch = fetch): GitHubApi {
  const { repoPath, branchPath, request, responseError, getJson, graphql, graphqlError } = createClient(
    cfg,
    (input, init) => fetchImpl(input, init)
  );
  // GraphQL afvist med 401/403 (fx en nøgletype uden GraphQL): brug REST resten af tiden
  let graphqlBlocked = false;

  // Tekster for én batch via GraphQL. Kun tekster, hvis blob-sha passer, tæller;
  // resten hentes over REST. null = GraphQL kan ikke bruges med denne nøgle.
  async function graphqlBlobs(shas: string[]): Promise<Map<string, string> | null> {
    const vars: Record<string, string> = { owner: cfg.owner, name: cfg.repo };
    const decl = ["$owner: String!", "$name: String!"];
    const fields: string[] = [];
    shas.forEach((sha, i) => {
      vars[`o${i}`] = sha;
      decl.push(`$o${i}: GitObjectID!`);
      fields.push(`b${i}: object(oid: $o${i}) { ... on Blob { text isBinary isTruncated } }`);
    });
    const query = `query(${decl.join(", ")}) { repository(owner: $owner, name: $name) { ${fields.join(" ")} } }`;
    const { res, data, errors } = await graphql<{ repository?: Record<string, BlobNode | null> | null }>(
      query,
      vars
    );
    if (!res.ok) {
      const err = await responseError(res);
      if (err.kind === "auth" || err.kind === "forbidden") return null;
      if (err.kind === "other") return new Map(); // fx 502 på en tung forespørgsel: denne batch over REST
      throw err;
    }
    const repo = data?.repository;
    if (!repo) {
      if (errors) {
        const err = graphqlError(errors);
        if (err.kind === "rate-limit") throw err;
        if (err.kind === "forbidden") return null;
      }
      return new Map(); // alt over REST
    }
    const out = new Map<string, string>();
    for (let i = 0; i < shas.length; i++) {
      const node = repo[`b${i}`];
      if (!node || typeof node.text !== "string" || node.isBinary || node.isTruncated) continue;
      if ((await gitBlobSha(node.text)) === shas[i].toLowerCase()) out.set(shas[i], node.text);
    }
    return out;
  }

  async function restBlob(sha: string): Promise<string> {
    const res = await request(`${repoPath}/git/blobs/${encodeURIComponent(sha)}`, {
      accept: "application/vnd.github.raw+json",
    });
    if (!res.ok) throw await responseError(res);
    const buf = await readBody(res, () => res.arrayBuffer());
    // ignoreBOM: true = behold BOM'en, så teksten er byte-for-byte som i git
    return new TextDecoder("utf-8", { ignoreBOM: true }).decode(buf);
  }

  return {
    async getHead(etag) {
      const headers: Record<string, string> = {};
      if (etag) headers["If-None-Match"] = etag;
      const res = await request(`${repoPath}/commits/${branchPath}`, {
        accept: "application/vnd.github.sha",
        cache: "no-store",
        headers,
      });
      if (res.status === 304) return null;
      if (!res.ok) throw await responseError(res);
      const commitSha = (await readBody(res, () => res.text())).trim().toLowerCase();
      if (!/^[0-9a-f]{40,64}$/.test(commitSha)) {
        throw new GitHubError("other", "Uventet svar fra GitHub (seneste commit)", res.status);
      }
      const commit = await getJson<{ tree?: { sha?: string } }>(`${repoPath}/git/commits/${commitSha}`);
      const treeSha = commit.tree?.sha;
      if (!treeSha) throw new GitHubError("other", "Uventet svar fra GitHub (commit uden træ)");
      return { head: { commitSha, treeSha }, etag: res.headers.get("etag") };
    },

    async getTree(treeSha) {
      const tree = await getJson<{
        truncated?: boolean;
        tree?: { path: string; mode: string; type: string; sha: string; size?: number }[];
      }>(`${repoPath}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`);
      if (tree.truncated) {
        throw new GitHubError("other", "Repoet er for stort til at hente på én gang (GitHub afkortede fillisten)");
      }
      const files: RemoteFile[] = [];
      for (const e of tree.tree ?? []) {
        // symlinks (120000) er også blobs, men aldrig noter
        if (e.type !== "blob" || e.mode === "120000") continue;
        files.push({ path: e.path, sha: e.sha, size: e.size ?? 0 });
      }
      return files;
    },

    async getBlobTexts(shas, onProgress?: ProgressFn) {
      const unique = [...new Set(shas)];
      const out = new Map<string, string>();
      const total = unique.length;
      let done = 0;
      onProgress?.(0, total);
      if (!total) return out;

      const viaRest: string[] = [];
      await pool(chunk(unique, GRAPHQL_BATCH), GRAPHQL_PARALLEL, async (batch) => {
        const got = graphqlBlocked ? null : await graphqlBlobs(batch);
        if (got === null) graphqlBlocked = true;
        for (const sha of batch) {
          const text = got?.get(sha);
          if (text === undefined) viaRest.push(sha);
          else out.set(sha, text);
        }
        done += got?.size ?? 0;
        if (got?.size) onProgress?.(done, total);
      });
      await pool(viaRest, REST_PARALLEL, async (sha) => {
        out.set(sha, await restBlob(sha));
        done++;
        onProgress?.(done, total);
      });
      return out;
    },

    async commit(expectedHead, message, additions: FileAddition[], deletions: string[]): Promise<CommitResult> {
      const input = {
        branch: { repositoryNameWithOwner: `${cfg.owner}/${cfg.repo}`, branchName: cfg.branch },
        expectedHeadOid: expectedHead,
        message: { headline: message },
        fileChanges: {
          additions: additions.map((a) => ({ path: a.path, contents: utf8ToBase64(a.content) })),
          deletions: deletions.map((path) => ({ path })),
        },
      };
      const { res, data, errors } = await graphql<{
        createCommitOnBranch?: { commit?: { oid?: string; tree?: { oid?: string } } } | null;
      }>(
        "mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid tree { oid } } } }",
        { input }
      );
      if (!res.ok) throw await responseError(res);
      if (errors) {
        // branchen pegede ikke længere på expectedHead (også kendt som falsk alarm fra GitHub)
        const text = errors.map((e) => e.message ?? "").join("; ");
        if (
          errors.some((e) => e.type === "STALE_DATA") ||
          /expected branch to point to|expectedHeadOid|expected head/i.test(text)
        ) {
          return "stale";
        }
        throw graphqlError(errors);
      }
      const commit = data?.createCommitOnBranch?.commit;
      if (!commit?.oid) throw new GitHubError("other", "Uventet svar fra GitHub (commit)");
      return { commitSha: commit.oid, treeSha: commit.tree?.oid };
    },
  };
}

// Kaster GitHubError (auth / not-found / offline / …), hvis forbindelsen ikke virker.
// Branchen tjekkes også — ellers melder opsætningen succes, og ingen synk lykkes.
export async function verifyConnection(cfg: Cfg, fetchImpl: typeof fetch = fetch): Promise<void> {
  const { repoPath, branchPath, getJson } = createClient(cfg, (input, init) => fetchImpl(input, init));
  await getJson(repoPath, { cache: "no-store" });
  try {
    await getJson(`${repoPath}/branches/${branchPath}`, { cache: "no-store" });
  } catch (e) {
    if (e instanceof GitHubError && e.kind === "not-found") {
      throw new GitHubError("not-found", `Branchen ${cfg.branch} findes ikke i ${cfg.owner}/${cfg.repo}`, e.status);
    }
    throw e;
  }
}
