import { useEffect, useState } from "react";
import { useEditor, EditorContent, Extension, type Editor } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import { Markdown } from "tiptap-markdown";
import { openUrl } from "../backend";
import { useStore, type Doc } from "../store";
import { changedBlockIndices, splitBlocks } from "../diff";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import LinkDialog from "./LinkDialog";

// ⌘1–⌘6 for overskrifter, ⌘0 for brødtekst, Tab/⇧Tab som indrykning i lister.
// Tab sluges altid, så fokus ikke hopper ud af editoren.
const EditorShortcuts = Extension.create({
  name: "editorShortcuts",
  addKeyboardShortcuts() {
    const shortcuts: Record<string, () => boolean> = {
      "Mod-0": () => this.editor.chain().focus().setParagraph().run(),
      Tab: () => this.editor.chain().focus().sinkListItem("listItem").run() || true,
      "Shift-Tab": () =>
        this.editor.chain().focus().liftListItem("listItem").run() || true,
    };
    for (let level = 1; level <= 6; level++) {
      shortcuts[`Mod-${level}`] = () =>
        this.editor
          .chain()
          .focus()
          .toggleHeading({ level: level as 1 | 2 | 3 | 4 | 5 | 6 })
          .run();
    }
    return shortcuts;
  },
});

// Fremhæver de topniveau-blokke, Claude har ændret. Sættes via
// transaction-meta med en liste af blokindeks; tom liste rydder.
const claudeHighlightKey = new PluginKey("claudeHighlight");

const ClaudeHighlight = Extension.create({
  name: "claudeHighlight",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: claudeHighlightKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, old) {
            const meta = tr.getMeta(claudeHighlightKey) as number[] | undefined;
            if (meta !== undefined) {
              if (!meta.length) return DecorationSet.empty;
              const decos: Decoration[] = [];
              let index = 0;
              tr.doc.forEach((node, offset) => {
                if (meta.includes(index)) {
                  decos.push(
                    Decoration.node(offset, offset + node.nodeSize, {
                      class: "claude-changed",
                    })
                  );
                }
                index++;
              });
              return DecorationSet.create(tr.doc, decos);
            }
            return old.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
        },
      }),
    ];
  },
});

function getMarkdown(editor: Editor): string {
  return (editor.storage as { markdown: { getMarkdown: () => string } }).markdown.getMarkdown();
}

export default function LayoutEditor({ doc }: { doc: Doc }) {
  const path = doc.path;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);

  const editor = useEditor({
    extensions: [
      StarterKit,
      EditorShortcuts,
      ClaudeHighlight,
      Link.configure({ openOnClick: false, autolink: true }),
      Markdown.configure({
        html: false,
        transformPastedText: true,
        transformCopiedText: true,
      }),
    ],
    content: doc.content,
    autofocus: "end",
    editorProps: {
      attributes: {
        class: "layout-content",
        spellcheck: "true",
        autocorrect: "on",
        autocapitalize: "on",
        lang: "da",
      },
    },
    onUpdate: ({ editor }) => {
      useStore.getState().editContent(path, getMarkdown(editor));
    },
  });

  // ekstern opdatering (Claude) skrives ind i editoren
  useEffect(() => {
    if (!editor) return;
    const current = getMarkdown(editor);
    if (doc.content !== current) {
      editor.commands.setContent(doc.content, false);
    }
  }, [doc.content, editor]);

  // fremhæv de blokke, Claude har ændret, mens banneret vises
  useEffect(() => {
    if (!editor) return;
    let indices: number[] = [];
    if (doc.showExternalBanner && doc.prevContent !== null) {
      const blocks = splitBlocks(doc.content);
      // kun når markdown-blokke og topniveau-noder er 1:1, ellers udelades fremhævning
      if (editor.state.doc.childCount === blocks.length) {
        indices = changedBlockIndices(doc.prevContent, doc.content);
      }
    }
    editor.view.dispatch(editor.state.tr.setMeta(claudeHighlightKey, indices));
  }, [doc.content, doc.prevContent, doc.showExternalBanner, editor]);

  const applyLink = (url: string) => {
    if (!editor) return;
    if (editor.state.selection.empty) {
      editor
        .chain()
        .focus()
        .insertContent(`<a href="${url}">${url}</a>`)
        .run();
    } else {
      editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    }
  };

  const menuItems: MenuItem[] = editor
    ? [
        { label: "Fed", action: () => editor.chain().focus().toggleBold().run() },
        { label: "Kursiv", action: () => editor.chain().focus().toggleItalic().run() },
        {
          label: "Overskrift 1",
          action: () => editor.chain().focus().toggleHeading({ level: 1 }).run(),
        },
        {
          label: "Overskrift 2",
          action: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
        },
        {
          label: "Punktliste",
          action: () => editor.chain().focus().toggleBulletList().run(),
        },
        {
          label: "Citat",
          action: () => editor.chain().focus().toggleBlockquote().run(),
        },
        { label: "Link …", action: () => setLinkOpen(true) },
      ]
    : [];

  return (
    <div
      className="layout-editor"
      onKeyDown={(e) => {
        if (e.metaKey && !e.ctrlKey && !e.altKey && e.key === "k") {
          e.preventDefault();
          setLinkOpen(true);
        }
      }}
      onClick={(e) => {
        const anchor = (e.target as HTMLElement).closest("a");
        if (anchor && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          const href = anchor.getAttribute("href");
          if (href) void openUrl(href);
        }
      }}
      onContextMenu={(e) => {
        // uden markering: lad systemets menu (med staveforslag) vinde
        if (!editor || editor.state.selection.empty) return;
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <EditorContent editor={editor} className="layout-scroll" />
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}
      {linkOpen && (
        <LinkDialog onClose={() => setLinkOpen(false)} onSubmit={applyLink} />
      )}
    </div>
  );
}
