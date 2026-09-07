import { useEffect, useRef, useState } from "react";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
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
  indentWithTab,
} from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { useStore, type Doc } from "../store";
import { getScroll, saveScroll } from "../scrollMemory";
import { changedBlockIndices, splitBlocks } from "../diff";
import { saveClipboardImage } from "../images";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import LinkDialog from "./LinkDialog";
import { ghostText } from "./ghostText";

// [[Wikilinks]] fremhæves og kan ⌘-klikkes
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

const editorEvents = EditorView.domEventHandlers({
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

function setHeading(view: EditorView, level: number) {
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
  view.dispatch({ changes });
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
  const path = doc.path;

  useEffect(() => {
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
                setLinkOpen(true);
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
          EditorView.contentAttributes.of({
            spellcheck: "true",
            autocorrect: "on",
            autocapitalize: "on",
            lang: "da",
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              useStore.getState().editContent(path, update.state.doc.toString());
            }
          }),
        ],
      }),
      parent: containerRef.current!,
    });
    viewRef.current = view;
    view.focus();
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
      saveScroll(path, "markdown", view.scrollDOM.scrollTop);
      view.scrollDOM.removeEventListener("scroll", onScroll);
      viewRef.current = null;
      view.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

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
    { label: "Link …", action: () => setLinkOpen(true) },
  ];

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
          onClose={() => setLinkOpen(false)}
          onSubmit={(url) => viewRef.current && insertLink(viewRef.current, url)}
        />
      )}
    </div>
  );
}
