// Adgang til filsystemet. I den rigtige app går alt gennem Tauri;
// i en almindelig browser (npm run dev åbnet direkte) bruges et
// simuleret filsystem, så UI'et kan udvikles og testes uden appen.
// I browseren kan `window.claudeWrite(path, content)` simulere, at
// Claude ændrer en fil på disken.

import { convertFileSrc } from "@tauri-apps/api/core";

export interface FileEntry {
  name: string;
  path: string;
  rel_dir: string;
  modified_ms: number;
}

export interface FolderListing {
  files: FileEntry[];
  dirs: string[]; // alle undermapper som relative stier, også tomme
}

export interface GitSyncResult {
  status: "ok" | "offline" | "conflict" | "error";
  committed: number;
  detail: string;
}

interface Backend {
  listFolder(path: string): Promise<FolderListing>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  createFile(dir: string, name: string): Promise<string>;
  createFolder(dir: string, name: string): Promise<string>;
  saveImage(dir: string, name: string, dataBase64: string): Promise<string>;
  renameFile(path: string, newName: string): Promise<string>;
  deleteFile(path: string): Promise<void>;
  watchFolder(path: string): Promise<void>;
  gitInfo(path: string): Promise<boolean>;
  gitSync(path: string): Promise<GitSyncResult>;
  pickFolder(): Promise<string | null>;
  openUrl(url: string): Promise<void>;
  onFsChange(cb: (paths: string[]) => void): () => void;
  onOpenFile(cb: (paths: string[]) => void): () => void;
  frontendReady(): Promise<string[]>;
}

const isTauri = "__TAURI_INTERNALS__" in window;

function createTauriBackend(): Backend {
  return {
    listFolder: async (path) => {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<FolderListing>("list_folder", { path });
    },
    readFile: async (path) => {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<string>("read_file", { path });
    },
    writeFile: async (path, content) => {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<void>("write_file", { path, content });
    },
    createFile: async (dir, name) => {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<string>("create_file", { dir, name });
    },
    createFolder: async (dir, name) => {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<string>("create_folder", { dir, name });
    },
    saveImage: async (dir, name, dataBase64) => {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<string>("save_image", { dir, name, dataBase64 });
    },
    renameFile: async (path, newName) => {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<string>("rename_file", { path, newName });
    },
    deleteFile: async (path) => {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<void>("delete_file", { path });
    },
    watchFolder: async (path) => {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<void>("watch_folder", { path });
    },
    gitInfo: async (path) => {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<boolean>("git_info", { path });
    },
    gitSync: async (path) => {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<GitSyncResult>("git_sync", { path });
    },
    pickFolder: async () => {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, multiple: false });
      return typeof selected === "string" ? selected : null;
    },
    openUrl: async (url) => {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      return openUrl(url);
    },
    onFsChange: (cb) => {
      let unlisten: (() => void) | null = null;
      let cancelled = false;
      void import("@tauri-apps/api/event").then(({ listen }) =>
        listen<string[]>("fs-change", (event) => cb(event.payload)).then((fn) => {
          if (cancelled) fn();
          else unlisten = fn;
        })
      );
      return () => {
        cancelled = true;
        if (unlisten) unlisten();
      };
    },
    onOpenFile: (cb) => {
      let unlisten: (() => void) | null = null;
      let cancelled = false;
      void import("@tauri-apps/api/event").then(({ listen }) =>
        listen<string[]>("open-file", (event) => cb(event.payload)).then((fn) => {
          if (cancelled) fn();
          else unlisten = fn;
        })
      );
      return () => {
        cancelled = true;
        if (unlisten) unlisten();
      };
    },
    frontendReady: async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<string[]>("frontend_ready");
    },
  };
}

function createMockBackend(): Backend {
  const ROOT = "/Demo-noter";
  const files = new Map<string, string>([
    [
      `${ROOT}/Udkast — nyhedsbrev august.md`,
      `# Nyhedsbrev · august\n\nSommeren er ved at være forbi, og vi har brugt den på at bygge. Her er de tre ting fra august, som betyder mest for jer — og hvad de ændrer i hverdagen.\n\n## Tre ting der er nye\n\n- **Hurtigere søgning** — resultater vises mens du taster, også i store arkiver.\n- **Delte skabeloner** — hele teamet kan nu genbruge de samme udkast.\n- **Bedre eksport** — PDF og Word med jeres egen opsætning.\n\nSom altid: svar på denne mail, hvis noget driller. Vi læser det hele.\n`,
    ],
    [
      `${ROOT}/Statusmøde 28. august.md`,
      `# Statusmøde 28. august\n\n## Aftalt\n\n- Nyhedsbrevet sendes fredag.\n- Opsamling på kundemødet deles inden onsdag.\n\n## Til næste gang\n\nHver især skriver to punkter ind i denne note inden mødet.\n`,
    ],
    [`${ROOT}/Produktideer.md`, `# Produktideer\n\n- Skriv den første ned her.\n`],
    [`${ROOT}/Dagbog/Uge 35 2026.md`, `# Uge 35 2026\n\nUgen hvor editoren blev bygget.\n`],
    [`${ROOT}/Projekter/Markdown writer.md`, `# Markdown writer\n\nStatus og næste skridt.\n`],
    [`${ROOT}/Projekter/Arkiv/Gammel idé.md`, `# Gammel idé\n\nParkeret.\n`],
  ]);
  const mockDirs = new Set<string>(["Dagbog", "Projekter", "Projekter/Arkiv"]);
  const subs = new Set<(paths: string[]) => void>();
  const emit = (paths: string[]) => subs.forEach((cb) => cb(paths));

  // I browseren simuleres git-synk. `window.mockSyncStatus = "offline"`
  // tvinger en fejltilstand, så UI'et kan testes.
  let pendingChanges = 0;

  (window as unknown as Record<string, unknown>).claudeWrite = (
    path: string,
    content: string
  ) => {
    files.set(path, content);
    emit([path]);
  };

  return {
    listFolder: async (path) => ({
      files: Array.from(files.keys())
        .filter((p) => p.startsWith(path + "/"))
        .map((p) => {
          const rel = p.slice(path.length + 1);
          const idx = rel.lastIndexOf("/");
          return {
            name: (p.split("/").pop() ?? p).replace(/\.md$/i, ""),
            path: p,
            rel_dir: idx === -1 ? "" : rel.slice(0, idx),
            modified_ms: Date.now(),
          };
        }),
      dirs: Array.from(mockDirs).sort(),
    }),
    readFile: async (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error("Filen findes ikke");
      return content;
    },
    writeFile: async (path, content) => {
      files.set(path, content);
      pendingChanges += 1;
      emit([path]);
    },
    createFile: async (dir, name) => {
      let candidate = `${dir}/${name}.md`;
      let i = 2;
      while (files.has(candidate)) candidate = `${dir}/${name} ${i++}.md`;
      files.set(candidate, "");
      emit([candidate]);
      return candidate;
    },
    saveImage: async (dir, name) => `${dir}/${name}`,
    createFolder: async (dir, name) => {
      const parentRel = dir === ROOT ? "" : dir.slice(ROOT.length + 1);
      let rel = parentRel ? `${parentRel}/${name}` : name;
      let i = 2;
      while (mockDirs.has(rel)) {
        rel = parentRel ? `${parentRel}/${name} ${i}` : `${name} ${i}`;
        i += 1;
      }
      mockDirs.add(rel);
      return `${ROOT}/${rel}`;
    },
    renameFile: async (path, newName) => {
      const dir = path.slice(0, path.lastIndexOf("/"));
      const newPath = `${dir}/${newName}.md`;
      if (files.has(newPath))
        throw new Error("Der findes allerede en note med det navn");
      const content = files.get(path) ?? "";
      files.delete(path);
      files.set(newPath, content);
      emit([path, newPath]);
      return newPath;
    },
    deleteFile: async (path) => {
      files.delete(path);
      emit([path]);
    },
    watchFolder: async () => {},
    gitInfo: async () => true,
    gitSync: async () => {
      await new Promise((r) => setTimeout(r, 600));
      const forced = (window as unknown as Record<string, unknown>).mockSyncStatus;
      const committed = pendingChanges;
      pendingChanges = 0;
      if (forced === "offline" || forced === "conflict" || forced === "error") {
        return { status: forced, committed, detail: "Simuleret fejl" };
      }
      return { status: "ok", committed, detail: "" };
    },
    pickFolder: async () => ROOT,
    openUrl: async (url) => {
      window.open(url, "_blank");
    },
    onFsChange: (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    onOpenFile: () => () => {},
    frontendReady: async () => [],
  };
}

const backend: Backend = isTauri ? createTauriBackend() : createMockBackend();

export const listFolder = backend.listFolder;
export const readFile = backend.readFile;
export const writeFile = backend.writeFile;
export const createFile = backend.createFile;
export const createFolder = backend.createFolder;
export const saveImage = backend.saveImage;

// Absolut filsti → URL webviewet kan vise (asset-protokollen i Tauri)
export function resolveAsset(absPath: string): string {
  return isTauri ? convertFileSrc(absPath) : absPath;
}
export const renameFile = backend.renameFile;
export const deleteFile = backend.deleteFile;
export const watchFolder = backend.watchFolder;
export const gitInfo = backend.gitInfo;
export const gitSync = backend.gitSync;
export const pickFolder = backend.pickFolder;
export const openUrl = backend.openUrl;
export const onFsChange = backend.onFsChange;
export const onOpenFile = backend.onOpenFile;
export const frontendReady = backend.frontendReady;
