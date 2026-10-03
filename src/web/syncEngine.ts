// Synk mellem telefonens lokale kopi (LocalStore) og GitHub (GitHubApi).
// Pull fletter fjernændringer ind med samme trevejsfletning som desktop;
// push sender alle lokale ændringer som ét atomisk commit. Alle beslutninger
// om en post træffes inde i store.update, så en samtidig skrivning fra UI'et
// aldrig overskrives — og fejler noget midt i en synk, er de lokale data intakte.
import { mergeThreeWay } from "../diff";
import { gitBlobSha } from "./blobSha";
import {
  GitHubError,
  isDirty,
  type FileAddition,
  type FileRecord,
  type GitHubApi,
  type LocalStore,
  type ProgressFn,
  type RemoteFile,
  type RemoteHead,
  type SyncMeta,
  type SyncOutcome,
} from "./types";

export interface SyncEngineOptions {
  onProgress?: ProgressFn; // fremdrift, når noter hentes (fx første hentning)
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface SyncEngine {
  // Kører højst én synk ad gangen. Kaldes sync, mens en kører, venter kaldet
  // og får resultatet af én ny synk bagefter (flere ventende kald deler den).
  sync(): Promise<SyncOutcome>;
}

const MAX_ATTEMPTS = 3; // commit-forsøg pr. synk, når branchen flytter sig imens
const BACKOFF_MS = [500, 1500];
const LOCK_NAME = "mw-sync";
const UPDATE_PARALLEL = 50;

// Samme filer som desktopens collect_md: .md, og ingen mappe/fil der starter med "."
export function isNoteFile(path: string): boolean {
  return /\.md$/i.test(path) && !path.split("/").some((seg) => seg.startsWith("."));
}

// Kun til sammenligning (NFC/NFD og store/små bogstaver) — gem altid den originale sti
export function pathKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

// Som desktop ("Noter: A, B, C"), men markeret, så man kan se, hvor det kom fra
export function commitMessage(paths: string[]): string {
  const names = paths.slice(0, 3).map((p) => p.slice(p.lastIndexOf("/") + 1).replace(/\.md$/i, ""));
  const more = paths.length > 3 ? ` (+${paths.length - 3} flere)` : "";
  return `Noter (mobil): ${names.join(", ")}${more}`;
}

async function inParallel(tasks: (() => Promise<void>)[], limit: number): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) await tasks[next++]();
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

// Posten uden udestående commit-markering
function settled(r: FileRecord): FileRecord {
  const { sent: _sent, ...rest } = r;
  return rest;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function errorDetail(e: unknown, phase: "pull" | "push"): { status: SyncOutcome["status"]; detail: string } {
  if (e instanceof GitHubError) {
    switch (e.kind) {
      case "offline":
        return { status: "offline", detail: "Ingen forbindelse til GitHub — ændringerne er gemt på telefonen." };
      case "auth":
        return { status: "error", detail: "Adgangsnøglen virker ikke længere. Indsæt en ny under Indstillinger." };
      case "forbidden":
        return {
          status: "error",
          detail: phase === "push" ? "Nøglen har ikke skriveadgang til repoet." : "Nøglen har ikke adgang til repoet.",
        };
      case "not-found":
        return { status: "error", detail: "Repoet eller branchen blev ikke fundet — har nøglen stadig adgang?" };
      case "rate-limit":
        return { status: "error", detail: "GitHub beder os vente lidt, før vi synker igen." };
      default:
        return { status: "error", detail: e.message };
    }
  }
  return { status: "error", detail: e instanceof Error ? e.message : String(e) };
}

interface PushPlan {
  additions: FileAddition[];
  deletions: string[];
  message: string;
}

export function createSyncEngine(store: LocalStore, api: GitHubApi, opts: SyncEngineOptions = {}): SyncEngine {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;

  // Henter og fletter det remote træ ind. Returnerer de remote notestier
  // (null = træet er det samme som sidst, så intet skulle hentes).
  async function pull(
    head: RemoteHead,
    base: SyncMeta,
    report: boolean,
    changed: Set<string>
  ): Promise<Set<string> | null> {
    if (base.headTree && head.treeSha === base.headTree) return null;
    const remote = (await api.getTree(head.treeSha)).filter((f) => isNoteFile(f.path));
    const remoteByPath = new Map(remote.map((f) => [f.path, f]));
    const remoteByKey = new Map<string, RemoteFile>();
    for (const f of remote) if (!remoteByKey.has(pathKey(f.path))) remoteByKey.set(pathKey(f.path), f);

    const locals = await store.all();
    const localByPath = new Map(locals.map((r) => [r.path, r]));

    // Lokalt nye filer, som nu også findes på GitHub med en anden stavemåde
    // (NFD/NFC eller store/små bogstaver): overtag GitHubs sti, så der ikke opstår dubletter
    const adopt = new Map<string, string>(); // remote sti → lokal sti
    for (const r of locals) {
      if (r.sha !== null || r.deleted || remoteByPath.has(r.path) || !isNoteFile(r.path)) continue;
      const f = remoteByKey.get(pathKey(r.path));
      if (f && !localByPath.has(f.path) && !adopt.has(f.path)) adopt.set(f.path, r.path);
    }

    // kendt tekst kan genbruges (fx en note, der er omdøbt på computeren)
    const known = new Map<string, string>();
    for (const r of locals) if (r.sha !== null && r.base !== null) known.set(r.sha, r.base);
    const need: string[] = [];
    for (const f of remote) {
      const local = localByPath.get(f.path) ?? localByPath.get(adopt.get(f.path) ?? "");
      if (local && local.sha === f.sha) continue;
      if (!known.has(f.sha)) need.push(f.sha);
    }
    // alt hentes, før noget skrives: går nettet midt i, er intet ændret lokalt
    const fetched = need.length ? await api.getBlobTexts(need, opts.onProgress) : new Map<string, string>();
    const textOf = (sha: string) => fetched.get(sha) ?? known.get(sha);
    const t = now();
    const mark = (path: string) => {
      if (report) changed.add(path);
    };

    // Fjernversionen ind i én post; afgøres ud fra postens aktuelle indhold
    // Uændret på GitHub trods nyt head: et udestående commit landede ikke
    const unchanged = (cur: FileRecord) => (cur.sent != null ? settled(cur) : undefined);

    const decide = (cur: FileRecord | undefined, f: RemoteFile, text: string): FileRecord | undefined => {
      if (cur && cur.sha === f.sha) return unchanged(cur);
      if (!cur) {
        mark(f.path);
        return { path: f.path, sha: f.sha, base: text, content: text, deleted: false, mtime: t };
      }
      if (typeof cur.sent === "string" && cur.sent === text && isDirty(cur)) {
        // vores eget commit landede, men svaret gik tabt: GitHub har præcis det
        // sendte, så alt lokalt siden (videre skrivning, sletning) er stadig vores.
        // Kun mens posten er beskidt — er den ren, er fjernversionen den nyeste.
        return settled({ ...cur, sha: f.sha, base: text });
      }
      if (cur.deleted) {
        // slettet her, ændret der: behold den ændrede version
        mark(f.path);
        return settled({ ...cur, sha: f.sha, base: text, content: text, deleted: false, mtime: t });
      }
      let content: string;
      if (!isDirty(cur) || cur.content === null || cur.content === text) content = text;
      else if (cur.base !== null && cur.base === text) content = cur.content;
      else content = mergeThreeWay(cur.base ?? "", cur.content, text); // overlap: begge bevares, min først
      const differs = content !== cur.content;
      if (differs) mark(f.path);
      return settled({ ...cur, sha: f.sha, base: text, content, mtime: differs ? t : cur.mtime });
    };

    const applyRemote = (f: RemoteFile) => async () => {
      const text = textOf(f.sha);
      await store.update(f.path, (cur) => {
        if (cur && cur.sha === f.sha) return unchanged(cur);
        return text === undefined ? undefined : decide(cur, f, text);
      });
    };

    const adoptRemote = (f: RemoteFile, localPath: string) => async () => {
      let mine: FileRecord | undefined;
      await store.update(localPath, (cur) => {
        if (!cur || cur.sha !== null || cur.deleted) return undefined;
        mine = cur;
        return null;
      });
      if (!mine) return applyRemote(f)();
      const moved = mine;
      let restore = false;
      await store.update(f.path, (cur) => {
        // også oprettet under GitHubs sti imens (sjældent): læg vores tilbage som egen fil
        if (cur) {
          restore = true;
          const text = textOf(f.sha);
          return text === undefined ? undefined : decide(cur, f, text);
        }
        const text = textOf(f.sha);
        if (text === undefined) {
          restore = true;
          return undefined;
        }
        return decide({ ...moved, path: f.path, base: null }, f, text);
      });
      if (restore) {
        await store.update(localPath, (cur) => cur ?? moved);
      } else {
        mark(localPath);
        mark(f.path);
      }
    };

    // Forsvundet fra GitHub: ren post slettes; lokale ændringer beholdes som ny fil
    const applyRemoved = (path: string) => async () => {
      await store.update(path, (cur) => {
        if (!cur || cur.sha === null || remoteByPath.has(cur.path)) return undefined;
        if (cur.deleted || !isDirty(cur)) {
          if (!cur.deleted) mark(path);
          return null;
        }
        return settled({ ...cur, sha: null, base: null });
      });
    };

    const tasks: (() => Promise<void>)[] = [];
    for (const f of remote) {
      const localPath = adopt.get(f.path);
      tasks.push(localPath ? adoptRemote(f, localPath) : applyRemote(f));
    }
    for (const r of locals) {
      if (r.sha !== null && !remoteByPath.has(r.path) && isNoteFile(r.path)) tasks.push(applyRemoved(r.path));
    }
    await inParallel(tasks, UPDATE_PARALLEL);
    return new Set(remoteByPath.keys());
  }

  // Hvad skal sendes? remotePaths = notestierne i det træ, vi lige har hentet
  // (null: uændret siden sidst — så findes en post med sha på GitHub).
  async function planPush(remotePaths: Set<string> | null): Promise<PushPlan | null> {
    const onRemote = (r: FileRecord) => r.sha !== null && (remotePaths ? remotePaths.has(r.path) : true);
    const additions: FileAddition[] = [];
    const deletions: string[] = [];
    const localOnly: string[] = [];
    for (const r of await store.all()) {
      if (!isDirty(r) || !isNoteFile(r.path)) continue;
      if (r.deleted) {
        // GitHub afviser hele commit'et, hvis en slettet sti ikke findes
        if (onRemote(r)) deletions.push(r.path);
        else localOnly.push(r.path);
      } else if (r.content !== null) {
        additions.push({ path: r.path, content: r.content });
      }
    }
    for (const path of localOnly) {
      await store.update(path, (cur) => (cur && cur.deleted && !onRemote(cur) ? null : undefined));
    }
    if (!additions.length && !deletions.length) return null;
    additions.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    deletions.sort();
    return { additions, deletions, message: commitMessage([...additions.map((a) => a.path), ...deletions]) };
  }

  // Efter et vellykket commit: posterne peger nu på det, der blev sendt.
  // content røres ikke — er noten skrevet i imens, forbliver den beskidt.
  async function applyPushed(plan: PushPlan): Promise<void> {
    const shas = await Promise.all(plan.additions.map((a) => gitBlobSha(a.content)));
    const t = now();
    const tasks: (() => Promise<void>)[] = [];
    plan.additions.forEach((a, i) => {
      tasks.push(async () => {
        await store.update(a.path, (cur) => {
          // slettet lokalt under push: filen findes nu på GitHub, så sletningen sendes næste gang
          if (!cur) return { path: a.path, sha: shas[i], base: a.content, content: a.content, deleted: true, mtime: t };
          return settled({ ...cur, sha: shas[i], base: a.content });
        });
      });
    });
    for (const path of plan.deletions) {
      tasks.push(async () => {
        await store.update(path, (cur) => {
          if (!cur) return undefined;
          if (cur.deleted) return null;
          return settled({ ...cur, sha: null, base: null }); // genskabt imens: nu en ny lokal fil
        });
      });
    }
    await inParallel(tasks, UPDATE_PARALLEL);
  }

  // Lige før commit'et: husk, hvad der sendes, hvis svaret skulle gå tabt
  async function markSent(plan: PushPlan): Promise<void> {
    await inParallel(
      plan.additions.map((a) => async () => {
        await store.update(a.path, (cur) => (cur ? { ...cur, sent: a.content } : undefined));
      }),
      UPDATE_PARALLEL
    );
  }

  async function runSync(): Promise<SyncOutcome> {
    const changed = new Set<string>();
    let initial = false;
    let committed = 0;
    let phase: "pull" | "push" = "pull";
    const outcome = (status: SyncOutcome["status"], detail: string): SyncOutcome => ({
      status,
      committed,
      detail,
      changedPaths: [...changed],
      initial,
    });
    try {
      let base = await store.getMeta();
      initial = base.headCommit === null;
      // 304 (uændret) er gratis; uden kendt træ spørges der helt forfra
      let res = await api.getHead(base.headCommit ? base.headEtag : null);
      if (!res && !(base.headCommit && base.headTree)) res = await api.getHead(null);
      if (!res && !(base.headCommit && base.headTree)) {
        throw new GitHubError("other", "Uventet svar fra GitHub (intet seneste commit)");
      }
      let head: RemoteHead = res ? res.head : { commitSha: base.headCommit!, treeSha: base.headTree! };
      let etag = res ? res.etag : base.headEtag;
      if (res && head.commitSha === base.headCommit && (etag !== base.headEtag || head.treeSha !== base.headTree)) {
        // samme commit (fx vores eget seneste push): husk ETag'en, så næste opslag bliver et 304
        base = { ...base, headTree: head.treeSha, headEtag: etag };
        await store.setMeta(base);
      }
      let remotePaths: Set<string> | null = null;

      for (let attempt = 1; ; attempt++) {
        phase = "pull";
        if (head.commitSha !== base.headCommit) {
          remotePaths = await pull(head, base, !initial, changed);
          base = { headCommit: head.commitSha, headTree: head.treeSha, headEtag: etag };
          await store.setMeta(base); // først når alle poster er skrevet
        }

        phase = "push";
        const plan = await planPush(remotePaths);
        if (!plan) {
          if (initial) return outcome("ok", `Hentet ${plural(remotePaths?.size ?? 0, "note", "noter")}`);
          return outcome("ok", changed.size ? `${plural(changed.size, "note", "noter")} hentet` : "Alt er synket");
        }
        await markSent(plan);
        const result = await api.commit(base.headCommit!, plan.message, plan.additions, plan.deletions);
        if (result === "stale") {
          // nogen nåede at committe imens (eller falsk alarm fra GitHub): hent, flet, prøv igen
          if (attempt >= MAX_ATTEMPTS) {
            return outcome(
              "conflict",
              "Noterne blev ændret et andet sted, mens vi sendte. Ændringerne er gemt på telefonen og sendes ved næste synk."
            );
          }
          await sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length) - 1] + Math.random() * 250);
          phase = "pull";
          const fresh = await api.getHead(null);
          if (fresh) {
            head = fresh.head;
            etag = fresh.etag;
          }
          continue;
        }
        committed = plan.additions.length + plan.deletions.length;
        await applyPushed(plan);
        await store.setMeta({ headCommit: result.commitSha, headTree: result.treeSha ?? null, headEtag: null });
        const parts = [`${plural(committed, "ændring", "ændringer")} sendt`];
        if (changed.size) parts.unshift(`${plural(changed.size, "note", "noter")} hentet`);
        return outcome("ok", parts.join(", "));
      }
    } catch (e) {
      const { status, detail } = errorDetail(e, phase);
      return outcome(status, detail);
    }
  }

  // Én synk ad gangen — også på tværs af faner, hvis browseren har Web Locks
  async function withLock(fn: () => Promise<SyncOutcome>): Promise<SyncOutcome> {
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (!locks?.request) return fn();
    return locks.request(LOCK_NAME, fn);
  }

  let chain: Promise<unknown> = Promise.resolve();
  let waiting: Promise<SyncOutcome> | null = null; // køet, ikke startet endnu

  return {
    sync() {
      if (waiting) return waiting;
      const p: Promise<SyncOutcome> = chain.then(() => {
        if (waiting === p) waiting = null;
        return withLock(runSync).catch((e) => errorDetailOutcome(e));
      });
      waiting = p;
      chain = p.catch(() => undefined);
      return p;
    },
  };
}

function errorDetailOutcome(e: unknown): SyncOutcome {
  const { status, detail } = errorDetail(e, "pull");
  return { status, committed: 0, detail, changedPaths: [], initial: false };
}
