// Fælles typer for mobil-/webudgaven, hvor noterne bor i IndexedDB og
// synkes med et GitHub-repo via api.github.com i stedet for git på disken.

// Én note i telefonens lokale kopi. Stien er repo-relativ og præcis som i
// git-træet (ingen Unicode-normalisering — én sti i vaulten er NFD).
export interface FileRecord {
  path: string; // fx "Arbejde/1 Projects/Møde.md"
  sha: string | null; // blob-sha på GitHub ved seneste synk; null = findes ikke på GitHub endnu
  base: string | null; // indholdet svarende til sha (til trevejsfletning); null = ukendt/ny
  content: string | null; // lokalt indhold; null = ikke hentet endnu
  deleted: boolean; // slettet lokalt, venter på push
  mtime: number; // ms; sidst ændret lokalt eller hentet med en ændring
  // Indholdet i et commit, vi har sendt, men endnu ikke fået svar på. Går
  // svaret tabt, genkendes vores eget commit ved næste pull på, at GitHubs
  // tekst er præcis denne. Fraværende/null = intet udestående.
  sent?: string | null;
}

// Beskidt = har lokale ændringer, der ikke er på GitHub endnu
export function isDirty(r: FileRecord): boolean {
  return r.deleted || r.sha === null || (r.content !== null && r.content !== r.base);
}

export interface SyncMeta {
  headCommit: string | null; // commit, den lokale kopi senest er synket med; null = aldrig hentet
  headTree: string | null;
  headEtag: string | null; // ETag fra seneste head-opslag (304 = uændret, koster intet)
}

export interface LocalStore {
  getMeta(): Promise<SyncMeta>;
  setMeta(meta: SyncMeta): Promise<void>;
  get(path: string): Promise<FileRecord | undefined>;
  all(): Promise<FileRecord[]>;
  // Atomisk læs-ændr-skriv i én transaktion. fn er synkron og må ikke
  // vente på andet: returnér ny post, null = slet posten, undefined = ingen ændring.
  update(
    path: string,
    fn: (cur: FileRecord | undefined) => FileRecord | null | undefined
  ): Promise<FileRecord | undefined>;
  clear(): Promise<void>;
}

export interface RemoteHead {
  commitSha: string;
  treeSha: string;
}

export interface RemoteFile {
  path: string;
  sha: string;
  size: number;
}

export interface FileAddition {
  path: string;
  content: string;
}

// stale = branchen flyttede sig; treeSha er rodtræet i det nye commit, hvis GitHub sendte det
export type CommitResult = { commitSha: string; treeSha?: string } | "stale";

export interface GitHubApi {
  // Seneste commit på branchen. etag: send forrige ETag; svaret er null, hvis uændret (304).
  getHead(etag: string | null): Promise<{ head: RemoteHead; etag: string | null } | null>;
  // Hele træet rekursivt; kun blobs. Kaster, hvis GitHub trunkerer svaret.
  getTree(treeSha: string): Promise<RemoteFile[]>;
  // Tekstindhold for blobs (UTF-8, BOM bevares). Kaster, hvis en blob ikke kan hentes.
  getBlobTexts(
    shas: string[],
    onProgress?: (done: number, total: number) => void
  ): Promise<Map<string, string>>;
  // Atomisk commit af alle ændringer oven på expectedHead (GraphQL createCommitOnBranch).
  commit(
    expectedHead: string,
    message: string,
    additions: FileAddition[],
    deletions: string[]
  ): Promise<CommitResult>;
}

export type GitHubErrorKind =
  | "offline"
  | "auth" // 401: nøglen er ugyldig, udløbet eller tilbagekaldt
  | "forbidden" // 403: nøglen mangler rettigheder (fx Contents: write)
  | "not-found" // 404: repoet/branchen findes ikke, eller nøglen kan ikke se det
  | "rate-limit"
  | "other";

export class GitHubError extends Error {
  kind: GitHubErrorKind;
  status?: number;
  constructor(kind: GitHubErrorKind, message: string, status?: number) {
    super(message);
    this.name = "GitHubError";
    this.kind = kind;
    this.status = status;
  }
}

export interface SyncOutcome {
  status: "ok" | "offline" | "conflict" | "error";
  committed: number; // antal filer i commit'et fra denne synk
  detail: string; // dansk, kan vises for brugeren
  changedPaths: string[]; // repo-relative stier, der er ændret lokalt af pull (til fs-change)
  initial: boolean; // første hentning nogensinde
}

export type ProgressFn = (done: number, total: number) => void;

// Forbindelsen gemt på telefonen (kun her — aldrig i koden eller på GitHub)
export interface GitHubConfig {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  connectedAt: number; // ms; bruges til at minde om, at nøglen udløber
}
