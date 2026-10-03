// Testhjælper: et lille in-memory "GitHub" med commits, træer og en branch,
// der kun kan flyttes fremad (som createCommitOnBranch med expectedHeadOid).
// Blob-sha'er er ægte git-sha'er (gitBlobSha); commit- og træ-id'er er syntetiske.
import { gitBlobSha } from "./blobSha";
import { GitHubError, type CommitResult, type GitHubApi, type GitHubErrorKind, type RemoteFile } from "./types";

interface FakeCommit {
  sha: string;
  tree: string;
  parent: string | null;
  message: string;
  by: "desktop" | "mobil";
  files: Map<string, string>;
}

export interface FakeRemoteHooks {
  // før et commit behandles; attempt tæller alle commit-kald (1, 2, …).
  // Kan fx committe "fra desktop", så commit'et bliver stale.
  beforeCommit?: (attempt: number) => void | Promise<void>;
  // efter et vellykket commit, før svaret når frem (sæt offline = svaret går tabt)
  afterCommit?: (commitSha: string) => void | Promise<void>;
  // midt i hentningen af blob-tekster (fx en skrivning fra UI'et, eller offline)
  onBlobFetch?: (shas: string[]) => void | Promise<void>;
}

export interface FakeRemoteStats {
  getHead: number;
  notModified: number; // getHead besvaret med "uændret" (304)
  getTree: number;
  blobRequests: number;
  blobsFetched: number;
  commitCalls: number;
  commits: number; // vellykkede commits fra mobilen
  staleAnswers: number;
}

export interface FakeRemote {
  api: GitHubApi;
  files(): Record<string, string>; // alle filer på branchen nu (også ikke-md og skjulte)
  head(): string;
  log(): { sha: string; message: string; by: "desktop" | "mobil"; files: Record<string, string> }[];
  // et commit "fra computeren"; null = slet filen. Returnerer det nye head.
  commitFromDesktop(changes: Record<string, string | null>, message?: string): string;
  setOffline(offline: boolean): void;
  failWith(kind: GitHubErrorKind | null): void; // alle kald kaster GitHubError(kind)
  staleNext(n?: number): void; // næste n commits svarer "stale", uden at branchen har flyttet sig
  hooks: FakeRemoteHooks;
  stats: FakeRemoteStats;
}

const encoder = new TextEncoder();

function sortedEntries(files: Map<string, string>): [string, string][] {
  return [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export function createFakeRemote(initial: Record<string, string> = {}): FakeRemote {
  const commits: FakeCommit[] = [];
  const treeIds = new Map<string, string>(); // serialiseret træ → id (samme indhold = samme træ)
  const trees = new Map<string, Map<string, string>>();
  const shaByContent = new Map<string, string>();
  const blobs = new Map<string, string>();
  let offline = false;
  let failKind: GitHubErrorKind | null = null;
  let staleCount = 0;
  const hooks: FakeRemoteHooks = {};
  const stats: FakeRemoteStats = {
    getHead: 0,
    notModified: 0,
    getTree: 0,
    blobRequests: 0,
    blobsFetched: 0,
    commitCalls: 0,
    commits: 0,
    staleAnswers: 0,
  };

  const id = (prefix: string, n: number) => prefix + n.toString(16).padStart(39, "0");
  const current = () => commits[commits.length - 1];

  function treeOf(files: Map<string, string>): string {
    const key = JSON.stringify(sortedEntries(files));
    let tree = treeIds.get(key);
    if (!tree) {
      tree = id("e", treeIds.size + 1);
      treeIds.set(key, tree);
      trees.set(tree, new Map(files));
    }
    return tree;
  }

  function addCommit(files: Map<string, string>, message: string, by: "desktop" | "mobil"): FakeCommit {
    const c: FakeCommit = {
      sha: id("c", commits.length + 1),
      tree: treeOf(files),
      parent: commits.length ? current().sha : null,
      message,
      by,
      files: new Map(files),
    };
    commits.push(c);
    return c;
  }

  async function shaOf(content: string): Promise<string> {
    let sha = shaByContent.get(content);
    if (!sha) {
      sha = await gitBlobSha(content);
      shaByContent.set(content, sha);
      blobs.set(sha, content);
    }
    return sha;
  }

  function check() {
    if (offline) throw new GitHubError("offline", "Ingen forbindelse til GitHub");
    if (failKind) throw new GitHubError(failKind, `Falsk fejl: ${failKind}`);
  }

  addCommit(new Map(Object.entries(initial)), "Første commit", "desktop");

  const api: GitHubApi = {
    async getHead(etag) {
      check();
      stats.getHead++;
      const c = current();
      const tag = `"${c.sha}"`;
      if (etag === tag) {
        stats.notModified++;
        return null;
      }
      return { head: { commitSha: c.sha, treeSha: c.tree }, etag: tag };
    },

    async getTree(treeSha) {
      check();
      stats.getTree++;
      const files = trees.get(treeSha);
      if (!files) throw new GitHubError("not-found", "Træet findes ikke", 404);
      const out: RemoteFile[] = [];
      for (const [path, content] of sortedEntries(files)) {
        out.push({ path, sha: await shaOf(content), size: encoder.encode(content).length });
      }
      return out;
    },

    async getBlobTexts(shas, onProgress) {
      check();
      stats.blobRequests++;
      await hooks.onBlobFetch?.(shas);
      check();
      for (const c of commits) for (const content of c.files.values()) await shaOf(content);
      const unique = [...new Set(shas)];
      const out = new Map<string, string>();
      onProgress?.(0, unique.length);
      for (const sha of unique) {
        const text = blobs.get(sha);
        if (text === undefined) throw new GitHubError("not-found", `Blob ${sha} findes ikke`, 404);
        out.set(sha, text);
        stats.blobsFetched++;
        onProgress?.(out.size, unique.length);
      }
      return out;
    },

    async commit(expectedHead, message, additions, deletions): Promise<CommitResult> {
      check();
      stats.commitCalls++;
      await hooks.beforeCommit?.(stats.commitCalls);
      check();
      if (staleCount > 0) {
        staleCount--;
        stats.staleAnswers++;
        return "stale";
      }
      const head = current();
      if (expectedHead !== head.sha) {
        stats.staleAnswers++;
        return "stale";
      }
      const paths = [...additions.map((a) => a.path), ...deletions];
      if (new Set(paths).size !== paths.length) {
        throw new GitHubError("other", "Stier skal være unikke på tværs af tilføjelser og sletninger");
      }
      const files = new Map(head.files);
      for (const path of deletions) {
        // som GitHub: sletning af en sti, der ikke findes, afviser hele commit'et
        if (!files.has(path)) throw new GitHubError("other", `Kan ikke slette ${path}: findes ikke`);
        files.delete(path);
      }
      for (const a of additions) files.set(a.path, a.content);
      const c = addCommit(files, message, "mobil");
      stats.commits++;
      await hooks.afterCommit?.(c.sha);
      check();
      return { commitSha: c.sha, treeSha: c.tree };
    },
  };

  return {
    api,
    files: () => Object.fromEntries(current().files),
    head: () => current().sha,
    log: () =>
      commits.map((c) => ({ sha: c.sha, message: c.message, by: c.by, files: Object.fromEntries(c.files) })),
    commitFromDesktop(changes, message = "Noter: fra computeren") {
      const files = new Map(current().files);
      for (const [path, content] of Object.entries(changes)) {
        if (content === null) files.delete(path);
        else files.set(path, content);
      }
      return addCommit(files, message, "desktop").sha;
    },
    setOffline: (b) => {
      offline = b;
    },
    failWith: (kind) => {
      failKind = kind;
    },
    staleNext: (n = 1) => {
      staleCount += n;
    },
    hooks,
    stats,
  };
}
