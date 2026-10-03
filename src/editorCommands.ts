import { useEffect, useRef, useSyncExternalStore } from "react";
import { openUrl } from "./backend";
import { useStore } from "./store";
import { useIsMobile } from "./useIsMobile";

// Den aktive editors formateringskommandoer. Layout- og markdown-editoren
// registrerer sig ved montering, så værktøjslinjen på mobil (FormatToolbar)
// kan formatere uden at kende editoren. Editoren kalder notifyEditor(), når
// markering, indhold eller fokus ændrer sig, så knapperne kan vise, hvad der
// er aktivt (og tabelhandlinger, når markøren står i en tabel).

export interface ToolbarState {
  bold: boolean;
  italic: boolean;
  heading: number; // 0 = brødtekst
  bulletList: boolean;
  taskList: boolean;
  inTable: boolean; // kun layout
  canUndo: boolean;
  canRedo: boolean;
  focused: boolean;
}

export interface TableCommands {
  addRowAfter(): void;
  addColumnAfter(): void;
  deleteRow(): void;
  deleteColumn(): void;
  deleteTable(): void;
}

export interface EditorCommands {
  kind: "layout" | "markdown";
  bold(): void;
  italic(): void;
  heading(): void; // H1 → H2 → H3 → brødtekst
  bulletList(): void;
  taskList(): void;
  indent(): void;
  outdent(): void;
  link(): void; // åbner link-dialogen
  undo(): void;
  redo(): void;
  blur(): void; // skjul tastaturet
  table?: TableCommands;
  state(): ToolbarState;
}

export interface EditorSnapshot {
  commands: EditorCommands | null;
  state: ToolbarState;
}

export const EMPTY_TOOLBAR_STATE: ToolbarState = {
  bold: false,
  italic: false,
  heading: 0,
  bulletList: false,
  taskList: false,
  inTable: false,
  canUndo: false,
  canRedo: false,
  focused: false,
};

let active: EditorCommands | null = null;
let snapshot: EditorSnapshot = { commands: null, state: EMPTY_TOOLBAR_STATE };
// uden lyttere (desktop har ingen værktøjslinje) udregnes tilstanden først,
// når nogen spørger
let stale = false;
const listeners = new Set<() => void>();

function readState(commands: EditorCommands | null): ToolbarState {
  if (!commands) return EMPTY_TOOLBAR_STATE;
  try {
    return commands.state();
  } catch {
    // editoren er ved at blive nedlagt
    return EMPTY_TOOLBAR_STATE;
  }
}

function sameState(a: ToolbarState, b: ToolbarState): boolean {
  return (Object.keys(a) as (keyof ToolbarState)[]).every((k) => a[k] === b[k]);
}

// true, hvis snapshot er skiftet
function recompute(): boolean {
  stale = false;
  const state = readState(active);
  if (snapshot.commands === active && sameState(snapshot.state, state)) return false;
  snapshot = { commands: active, state };
  return true;
}

function emit() {
  for (const listener of Array.from(listeners)) listener();
}

// Returnerer afregistreringen; den rydder kun, hvis ingen anden editor er
// kommet til imens
export function registerEditor(commands: EditorCommands): () => void {
  active = commands;
  recompute();
  emit();
  return () => {
    if (active !== commands) return;
    active = null;
    recompute();
    emit();
  };
}

export function getActiveEditor(): EditorCommands | null {
  return active;
}

export function notifyEditor(): void {
  if (!listeners.size) {
    stale = true;
    return;
  }
  if (recompute()) emit();
}

export function subscribeEditor(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getEditorSnapshot(): EditorSnapshot {
  if (stale) recompute();
  return snapshot;
}

export function useActiveEditor(): EditorSnapshot {
  return useSyncExternalStore(subscribeEditor, getEditorSnapshot, getEditorSnapshot);
}

export function nextHeading(level: number): number {
  return level >= 3 ? 0 : level + 1;
}

// Mobil: noten står i læsetilstand, til man trykker "Rediger" (store.editing);
// desktop er altid redigerbar. apply kaldes straks og ved hvert skift — ved
// skift synkront fra store'ns set(), altså inden for brugerens tryk, ellers
// åbner iOS ikke tastaturet, når editoren får fokus.
export function watchEditable(
  mobile: boolean,
  apply: (editable: boolean, toggled: boolean) => void
): () => void {
  const editableFor = (editing: boolean) => !mobile || editing;
  let current = editableFor(useStore.getState().editing);
  apply(current, false);
  return useStore.subscribe((s) => {
    const next = editableFor(s.editing);
    if (next === current) return;
    current = next;
    apply(next, true);
  });
}

// instance: editoren (null, til den findes); et skift starter forfra
export function useEditableMode(
  instance: unknown,
  apply: (editable: boolean, toggled: boolean) => void
): void {
  const mobile = useIsMobile();
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => {
    if (!instance) return;
    return watchEditable(mobile, (editable, toggled) => applyRef.current(editable, toggled));
  }, [instance, mobile]);
}

export type LinkTarget = { kind: "url"; url: string } | { kind: "note"; name: string } | null;

// Hvad et tryk på et link åbner på mobil. Kun http(s) og mailto åbnes uden
// for appen; relative .md-links og mdwriter://-links åbner noten på navn som
// et wikilink. Alt andet ignoreres, så appen aldrig navigerer væk fra sig selv.
export function linkTarget(href: string): LinkTarget {
  const h = href.trim();
  if (!h || h.startsWith("#")) return null;
  if (/^(https?:|mailto:)/i.test(h)) return { kind: "url", url: h };
  if (/^www\./i.test(h)) return { kind: "url", url: `https://${h}` };
  const scheme = h.match(/^([a-z][a-z0-9+.-]*):/i);
  if (scheme && scheme[1].toLowerCase() !== "mdwriter") return null;
  let path = h.replace(/^mdwriter:\/*/i, "").replace(/[?#].*$/, "");
  try {
    path = decodeURIComponent(path);
  } catch {
    // ugyldig procent-kodning: brug stien, som den står
  }
  const base = (path.split("/").pop() ?? "").trim();
  // andre filtyper (bilag.pdf) findes ikke som noter; "Møde 12.3" er et navn
  const name = /\.md$/i.test(base) ? base.slice(0, -3) : /\.[a-z][a-z0-9]{0,4}$/i.test(base) ? "" : base;
  return name ? { kind: "note", name } : null;
}

export function openLinkTarget(href: string): void {
  const target = linkTarget(href);
  if (target?.kind === "url") void openUrl(target.url);
  else if (target?.kind === "note") void useStore.getState().openWikilink(target.name);
}
