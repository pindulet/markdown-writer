import { useEffect, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { useStore, type Doc } from "../store";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import LinkDialog from "./LinkDialog";

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
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          markdown(),
          EditorView.lineWrapping,
          syntaxHighlighting(mdHighlight),
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
    return () => {
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

  const menuItems: MenuItem[] = [
    { label: "Fed", action: () => viewRef.current && wrapSelection(viewRef.current, "**") },
    { label: "Kursiv", action: () => viewRef.current && wrapSelection(viewRef.current, "*") },
    { label: "Overskrift 1", action: () => viewRef.current && setHeading(viewRef.current, 1) },
    { label: "Overskrift 2", action: () => viewRef.current && setHeading(viewRef.current, 2) },
    { label: "Punktliste", action: () => viewRef.current && togglePrefix(viewRef.current, "- ") },
    { label: "Citat", action: () => viewRef.current && togglePrefix(viewRef.current, "> ") },
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
