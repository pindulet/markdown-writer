import { useEffect, useRef, useState } from "react";
import {
  Compartment,
  EditorSelection,
  EditorState,
  StateEffect,
  StateField,
  type ChangeSpec,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  MatchDecorator,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentLess,
  indentMore,
  indentWithTab,
  redo,
  redoDepth,
  undo,
  undoDepth,
} from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting, syntaxTree, HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { useStore, type Doc } from "../store";
import { isMobileNow, useIsMobile } from "../useIsMobile";
import { getScroll, saveScroll } from "../scrollMemory";
import { changedBlockIndices, splitBlocks } from "../diff";
import { saveClipboardImage } from "../images";
import {
  nextHeading,
  notifyEditor,
  openLinkTarget,
  registerEditor,
  useEditableMode,
  type EditorCommands,
  type ToolbarState,
} from "../editorCommands";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import LinkDialog from "./LinkDialog";
import { ghostText } from "./ghostText";
import "../mobile-editor.css";

// [[Wikilinks]] fremhæves og kan ⌘-klikkes (i mobilens læsetilstand: trykkes)
const wikilinkMatcher = new MatchDecorator({
  regexp: /\[\[([^\][\n]+)\]\]/g,
  decoration: (match) =>
    Decoration.mark({
      class: "cm-wikilink",
      attributes: { "data-target": match[1] },
    }),
});

const wikilinkPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = wikilinkMatcher.createDeco(view);
    }
    update(update: ViewUpdate) {
      this.decorations = wikilinkMatcher.updateDeco(update, this.decorations);
    }
  },
  { decorations: (v) => v.decorations }
);

// Markdown-linket ([tekst](url) eller <url>) ved en position, hvis der er et
function linkAt(view: EditorView, pos: number): string | null {
  const inner = syntaxTree(view.state).resolveInner(pos, 1);
  for (let node: typeof inner | null = inner; node; node = node.parent) {
    if (node.name === "Link" || node.name === "Autolink") {
      const url = node.getChild("URL");
      return url ? view.state.sliceDoc(url.from, url.to) : null;
    }
  }
  return null;
}

const editorEvents = EditorView.domEventHandlers({
  // læsetilstand (kun mobil): et tryk på et link åbner det
  click: (event, view) => {
    if (view.state.facet(EditorView.editable)) return false;
    const link = (event.target as HTMLElement).closest(".cm-wikilink");
    const target = link?.getAttribute("data-target");
    if (target) {
      void useStore.getState().openWikilink(target);
      return true;
    }
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    const href = pos === null ? null : linkAt(view, pos);
    if (!href) return false;
    openLinkTarget(href);
    return true;
  },
  mousedown: (event) => {
    if (!event.metaKey && !event.ctrlKey) return false;
    const link = (event.target as HTMLElement).closest(".cm-wikilink");
    if (!link) return false;
    event.preventDefault();
    const target = link.getAttribute("data-target");
    if (target) void useStore.getState().openWikilink(target);
    return true;
  },
  paste: (event, view) => {
    const items = event.clipboardData?.items;
    if (!items) return false;
    for (const item of Array.from(items)) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (!file) continue;
        event.preventDefault();
        void saveClipboardImage(file).then((rel) => {
          if (!rel) return;
          const sel = view.state.selection.main;
          view.dispatch({
            changes: { from: sel.from, to: sel.to, insert: `![](${rel})` },
          });
        });
        return true;
      }
    }
    return false;
  },
});

// Linjefremhævning af Claudes ændringer, styret via effekt
const setClaudeHighlights = StateEffect.define<number[]>(); // linjestart-positioner
const claudeLineDeco = Decoration.line({ class: "cm-claude-changed" });
const claudeHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setClaudeHighlights)) {
        deco = effect.value.length
          ? Decoration.set(effect.value.map((pos) => claudeLineDeco.range(pos)))
          : Decoration.none;
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const mdHighlight = HighlightStyle.define([
  { tag: tags.heading1, fontWeight: "700", color: "var(--text-strong)" },
  { tag: tags.heading, fontWeight: "600", color: "var(--text-strong)" },
  { tag: tags.strong, fontWeight: "600", color: "var(--text-strong)" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.processingInstruction, color: "var(--text-faint)" },
  { tag: tags.meta, color: "var(--text-faint)" },
  { tag: tags.quote, color: "var(--text-muted)", fontStyle: "italic" },
  { tag: tags.link, color: "var(--accent)" },
  { tag: tags.url, color: "var(--text-faint)" },
  { tag: tags.monospace, color: "var(--accent)" },
]);

function wrapSelection(view: EditorView, marker: string): boolean {
  const { state } = view;
  const sel = state.selection.main;
  const selected = state.sliceDoc(sel.from, sel.to);
  if (
    selected.length >= marker.length * 2 &&
    selected.startsWith(marker) &&
    selected.endsWith(marker)
  ) {
    view.dispatch({
      changes: {
        from: sel.from,
        to: sel.to,
        insert: selected.slice(marker.length, selected.length - marker.length),
      },
    });
  } else {
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: `${marker}${selected}${marker}` },
      selection: {
        anchor: sel.from + marker.length,
        head: sel.to + marker.length,
      },
    });
  }
  view.focus();
  return true;
}

// caretAfterMark: markøren står efter "# " (ellers bliver den stående foran
// mærket, når linjen er tom eller markøren står i starten)
function setHeading(view: EditorView, level: number, caretAfterMark = false) {
  const { state } = view;
  const sel = state.selection.main;
  const fromLine = state.doc.lineAt(sel.from).number;
  const toLine = state.doc.lineAt(sel.to).number;
  const changes = [];
  const mark = "#".repeat(level) + " ";
  for (let n = fromLine; n <= toLine; n++) {
    const line = state.doc.line(n);
    const existing = line.text.match(/^#{1,6}\s+/);
    if (existing && existing[0] === mark) {
      changes.push({ from: line.from, to: line.from + existing[0].length, insert: "" });
    } else if (existing) {
      changes.push({ from: line.from, to: line.from + existing[0].length, insert: mark });
    } else {
      changes.push({ from: line.from, insert: mark });
    }
  }
  if (caretAfterMark) {
    const changeSet = state.changes(changes);
    view.dispatch({ changes: changeSet, selection: state.selection.map(changeSet, 1) });
  } else {
    view.dispatch({ changes });
  }
  view.focus();
}

function clearHeading(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  const fromLine = state.doc.lineAt(sel.from).number;
  const toLine = state.doc.lineAt(sel.to).number;
  const changes = [];
  for (let n = fromLine; n <= toLine; n++) {
    const line = state.doc.line(n);
    const existing = line.text.match(/^#{1,6}\s+/);
    if (existing) {
      changes.push({ from: line.from, to: line.from + existing[0].length, insert: "" });
    }
  }
  if (changes.length) view.dispatch({ changes });
  view.focus();
  return true;
}

const headingKeymap = Array.from({ length: 6 }, (_, i) => ({
  key: `Mod-${i + 1}`,
  run: (v: EditorView) => {
    setHeading(v, i + 1);
    return true;
  },
}));

function togglePrefix(view: EditorView, prefix: string) {
  const { state } = view;
  const sel = state.selection.main;
  const fromLine = state.doc.lineAt(sel.from).number;
  const toLine = state.doc.lineAt(sel.to).number;
  const changes = [];
  for (let n = fromLine; n <= toLine; n++) {
    const line = state.doc.line(n);
    if (line.text.startsWith(prefix)) {
      changes.push({ from: line.from, to: line.from + prefix.length, insert: "" });
    } else {
      changes.push({ from: line.from, insert: prefix });
    }
  }
  view.dispatch({ changes });
  view.focus();
}

function headingAt(state: EditorState, pos: number): number {
  return state.doc.lineAt(pos).text.match(/^(#{1,6})\s/)?.[1].length ?? 0;
}

function cycleHeading(view: EditorView) {
  const next = nextHeading(headingAt(view.state, view.state.selection.main.from));
  if (next) setHeading(view, next, true);
  else clearHeading(view);
}

// indrykning, punkt- og eventuelt tjekmarkør: "  - [ ] "
const LIST_MARK = /^(\s*)(?:([-*+])\s+(\[[ xX]\]\s+)?)?/;

// Punkt- og tjekliste fra værktøjslinjen. Den første linje bestemmer: er den
// allerede den slags liste, fjernes markøren; ellers sættes den (en punktliste
// bliver til en tjekliste og omvendt). Tomme linjer i en markering springes over.
function toggleList(view: EditorView, kind: "bullet" | "task") {
  const { state } = view;
  const sel = state.selection.main;
  const fromLine = state.doc.lineAt(sel.from).number;
  const toLine = state.doc.lineAt(sel.to).number;
  const isKind = (m: RegExpMatchArray) => (kind === "task" ? !!m[3] : !!m[2] && !m[3]);
  const remove = isKind(state.doc.line(fromLine).text.match(LIST_MARK)!);
  const changes: ChangeSpec[] = [];
  for (let n = fromLine; n <= toLine; n++) {
    const line = state.doc.line(n);
    if (fromLine !== toLine && !line.text.trim()) continue;
    const m = line.text.match(LIST_MARK)!;
    if (remove !== isKind(m)) continue;
    const bullet = m[2] ?? "-";
    changes.push({
      from: line.from + m[1].length,
      to: line.from + m[0].length,
      insert: remove ? "" : kind === "task" ? `${bullet} [ ] ` : `${bullet} `,
    });
  }
  const changeSet = state.changes(changes);
  view.dispatch({ changes: changeSet, selection: state.selection.map(changeSet, 1) });
  view.focus();
}

function markdownState(view: EditorView): ToolbarState {
  const { state } = view;
  const head = state.selection.main.head;
  let bold = false;
  let italic = false;
  const inner = syntaxTree(state).resolveInner(head, -1);
  for (let node: typeof inner | null = inner; node; node = node.parent) {
    if (node.name === "StrongEmphasis") bold = true;
    else if (node.name === "Emphasis") italic = true;
  }
  const m = state.doc.lineAt(head).text.match(LIST_MARK)!;
  return {
    bold,
    italic,
    heading: headingAt(state, head),
    bulletList: !!m[2] && !m[3],
    taskList: !!m[3],
    inTable: false,
    canUndo: undoDepth(state) > 0,
    canRedo: redoDepth(state) > 0,
    focused: view.hasFocus,
  };
}

function markdownCommands(view: EditorView, openLink: () => void): EditorCommands {
  const run = (fn: () => unknown) => () => {
    if (view.state.facet(EditorView.editable)) fn();
  };
  const andFocus = (fn: () => unknown) => () => {
    fn();
    view.focus();
  };
  return {
    kind: "markdown",
    bold: run(() => wrapSelection(view, "**")),
    italic: run(() => wrapSelection(view, "*")),
    heading: run(() => cycleHeading(view)),
    bulletList: run(() => toggleList(view, "bullet")),
    taskList: run(() => toggleList(view, "task")),
    indent: run(andFocus(() => indentMore(view))),
    outdent: run(andFocus(() => indentLess(view))),
    link: run(openLink),
    undo: run(andFocus(() => undo(view))),
    redo: run(andFocus(() => redo(view))),
    blur: () => view.contentDOM.blur(),
    state: () => markdownState(view),
  };
}

// Mobil: ingen stavekontrol i kildeteksten — den slår også iOS' "smarte"
// anførselstegn og tankestreger til (`---` bliver til `—-`)
function contentAttributes(mobile: boolean) {
  return EditorView.contentAttributes.of(
    mobile
      ? { spellcheck: "false", autocorrect: "on", autocapitalize: "sentences", lang: "da" }
      : { spellcheck: "true", autocorrect: "on", autocapitalize: "on", lang: "da" }
  );
}

function editableExtension(editable: boolean) {
  return [EditorView.editable.of(editable), EditorState.readOnly.of(!editable)];
}

const attributesConf = new Compartment();
const editableConf = new Compartment();

// Fokus uden at noten hopper: står markøren uden for det synlige, flyttes
// den til starten af den øverste synlige linje
function focusInView(view: EditorView) {
  try {
    const box = view.scrollDOM.getBoundingClientRect();
    const caret = view.coordsAtPos(view.state.selection.main.head);
    if (!caret || caret.top < box.top || caret.bottom > box.bottom) {
      const content = view.contentDOM.getBoundingClientRect();
      const padding = parseFloat(getComputedStyle(view.contentDOM).paddingLeft) || 0;
      const pos = view.posAtCoords(
        { x: content.left + padding + 1, y: Math.max(box.top, content.top) + 12 },
        false
      );
      view.dispatch({ selection: EditorSelection.cursor(pos) });
    }
  } catch {
    // kunne ikke måle (fx skjult editor): behold markeringen
  }
  view.focus();
}

function insertLink(view: EditorView, url: string) {
  const sel = view.state.selection.main;
  const text = view.state.sliceDoc(sel.from, sel.to) || url;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: `[${text}](${url})` },
  });
  view.focus();
}

export default function MarkdownEditor({ doc }: { doc: Doc }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  // markeringen, da link-dialogen blev åbnet (iOS sætter ellers markøren i starten)
  const linkRange = useRef<{ anchor: number; head: number } | null>(null);
  // til læse-/redigeringstilstand og værktøjslinjen; sættes, når editoren findes
  const [view, setView] = useState<EditorView | null>(null);
  const mobile = useIsMobile();
  const path = doc.path;

  const openLink = () => {
    const view = viewRef.current;
    if (!view) return;
    const { anchor, head } = view.state.selection.main;
    linkRange.current = { anchor, head };
    setLinkOpen(true);
  };
  const openLinkRef = useRef(openLink);
  openLinkRef.current = openLink;

  // genskab markeringen fra før dialogen
  const restoreLinkRange = (view: EditorView) => {
    const saved = linkRange.current;
    linkRange.current = null;
    if (!saved) return;
    const length = view.state.doc.length;
    view.dispatch({
      selection: { anchor: Math.min(saved.anchor, length), head: Math.min(saved.head, length) },
    });
  };

  useEffect(() => {
    const mobileNow = isMobileNow();
    const view = new EditorView({
      state: EditorState.create({
        doc: useStore.getState().docs[path]?.content ?? "",
        extensions: [
          history(),
          keymap.of([
            { key: "Mod-b", run: (v) => wrapSelection(v, "**") },
            { key: "Mod-i", run: (v) => wrapSelection(v, "*") },
            {
              key: "Mod-k",
              run: () => {
                openLinkRef.current();
                return true;
              },
            },
            ...headingKeymap,
            { key: "Mod-0", run: clearHeading },
            indentWithTab,
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          markdown(),
          EditorView.lineWrapping,
          syntaxHighlighting(mdHighlight),
          ghostText(path),
          claudeHighlightField,
          wikilinkPlugin,
          editorEvents,
          attributesConf.of(contentAttributes(mobileNow)),
          // mobil: læsetilstand, til man trykker "Rediger"
          editableConf.of(editableExtension(!mobileNow || useStore.getState().editing)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              useStore.getState().editContent(path, update.state.doc.toString());
            }
            if (update.docChanged || update.selectionSet || update.focusChanged) {
              notifyEditor();
            }
          }),
        ],
      }),
      parent: containerRef.current!,
    });
    viewRef.current = view;
    setView(view);
    // tastaturet må ikke springe op, når man åbner en note for at læse den
    if (!mobileNow) view.focus();
    const unregister = registerEditor(markdownCommands(view, () => openLinkRef.current()));
    // gendan scrollposition fra sidst fanen var åben; rAF venter på
    // CodeMirrors første layout, så positionen ikke bliver klippet
    const saved = getScroll(path, "markdown");
    if (saved !== undefined) {
      requestAnimationFrame(() => {
        view.scrollDOM.scrollTop = saved;
      });
    }
    const onScroll = () => saveScroll(path, "markdown", view.scrollDOM.scrollTop);
    view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      unregister();
      saveScroll(path, "markdown", view.scrollDOM.scrollTop);
      view.scrollDOM.removeEventListener("scroll", onScroll);
      viewRef.current = null;
      setView(null);
      view.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  useEffect(() => {
    view?.dispatch({ effects: attributesConf.reconfigure(contentAttributes(mobile)) });
  }, [view, mobile]);

  // "Rediger" giver fokus inden for trykket (så tastaturet kommer op) uden
  // at noten hopper; "Færdig" lukker tastaturet
  useEditableMode(view, (editable, toggled) => {
    if (!view) return;
    if (view.state.facet(EditorView.editable) !== editable) {
      view.dispatch({ effects: editableConf.reconfigure(editableExtension(editable)) });
    }
    if (!toggled) return;
    if (editable) focusInView(view);
    else view.contentDOM.blur();
  });

  // tastaturet er kommet op (viewport.ts): markøren kan nu ligge bag det
  useEffect(() => {
    if (!view) return;
    const onKeyboard = (e: Event) => {
      if (!(e as CustomEvent<boolean>).detail || !view.hasFocus) return;
      requestAnimationFrame(() => {
        if (viewRef.current !== view) return;
        view.dispatch({
          effects: EditorView.scrollIntoView(view.state.selection.main.head, {
            y: "nearest",
            yMargin: 24,
          }),
        });
      });
    };
    window.addEventListener("mw-keyboard", onKeyboard);
    return () => window.removeEventListener("mw-keyboard", onKeyboard);
  }, [view]);

  // ekstern opdatering (Claude) skrives ind i editoren
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (doc.content !== current) {
      const pos = Math.min(view.state.selection.main.head, doc.content.length);
      view.dispatch({
        changes: { from: 0, to: current.length, insert: doc.content },
        selection: { anchor: pos },
      });
    }
  }, [doc.content]);

  // fremhæv de linjer, Claude har ændret, mens banneret vises
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    let positions: number[] = [];
    if (doc.showExternalBanner && doc.prevContent !== null) {
      const blocks = splitBlocks(doc.content);
      const changed = changedBlockIndices(doc.prevContent, doc.content);
      const totalLines = view.state.doc.lines;
      for (const idx of changed) {
        const block = blocks[idx];
        if (!block) continue;
        for (let n = block.startLine + 1; n <= block.endLine + 1 && n <= totalLines; n++) {
          positions.push(view.state.doc.line(n).from);
        }
      }
      positions = Array.from(new Set(positions)).sort((a, b) => a - b);
    }
    view.dispatch({ effects: setClaudeHighlights.of(positions) });
  }, [doc.content, doc.prevContent, doc.showExternalBanner]);

  const menuItems: MenuItem[] = [
    { label: "Fed", action: () => viewRef.current && wrapSelection(viewRef.current, "**") },
    { label: "Kursiv", action: () => viewRef.current && wrapSelection(viewRef.current, "*") },
    { label: "Overskrift 1", action: () => viewRef.current && setHeading(viewRef.current, 1) },
    { label: "Overskrift 2", action: () => viewRef.current && setHeading(viewRef.current, 2) },
    { label: "Punktliste", action: () => viewRef.current && togglePrefix(viewRef.current, "- ") },
    { label: "Citat", action: () => viewRef.current && togglePrefix(viewRef.current, "> ") },
    {
      label: "Faktaboks",
      action: () => {
        const view = viewRef.current;
        if (!view) return;
        const line = view.state.doc.lineAt(view.state.selection.main.to);
        view.dispatch({
          changes: {
            from: line.to,
            insert: "\n\n> [!fakta] Overskrift\n> Tekst …",
          },
        });
        view.focus();
      },
    },
    { label: "Link …", action: openLink },
  ];

  const closeLink = () => {
    setLinkOpen(false);
    // mobil: tilbage i teksten, hvor man var, så tastaturet bliver oppe
    const view = viewRef.current;
    if (linkRange.current && mobile && view?.state.facet(EditorView.editable)) {
      restoreLinkRange(view);
      view.focus();
    }
    linkRange.current = null;
  };

  return (
    <div
      className="markdown-editor"
      ref={containerRef}
      onContextMenu={(e) => {
        const view = viewRef.current;
        // uden markering: lad systemets menu (med staveforslag) vinde
        if (!view || view.state.selection.main.empty) return;
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}
      {linkOpen && (
        <LinkDialog
          onClose={closeLink}
          onSubmit={(url) => {
            const view = viewRef.current;
            if (!view) return;
            restoreLinkRange(view);
            insertLink(view, url);
          }}
        />
      )}
    </div>
  );
}
