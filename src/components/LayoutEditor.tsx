import { useEffect, useRef, useState } from "react";
import { useEditor, EditorContent, Extension, type Editor } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Table from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";

// Uden en tight-attribut serialiserer tiptap-markdown tjeklister med
// blanke linjer mellem punkterne; punktlister har attributten indbygget.
const TightTaskList = TaskList.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      tight: {
        default: true,
        parseHTML: (el: HTMLElement) =>
          el.getAttribute("data-tight") === "true" || !el.querySelector("p"),
        renderHTML: (attrs: { tight?: boolean }) =>
          attrs.tight ? { "data-tight": "true" } : {},
      },
    };
  },
});
import { Markdown } from "tiptap-markdown";
import { openUrl } from "../backend";
import { useStore, type Doc } from "../store";
import { getScroll, saveScroll } from "../scrollMemory";
import { changedBlockIndices, splitBlocks } from "../diff";
import { resolveImageSrc, saveClipboardImage } from "../images";
import { MarkdownExtras } from "./markdownExtras";

// Billeder gemmes med relativ sti i markdown; kun visningen slås op
// gennem asset-protokollen.
const VaultImage = Image.extend({
  renderHTML({ HTMLAttributes }) {
    return [
      "img",
      { ...HTMLAttributes, src: resolveImageSrc(String(HTMLAttributes.src ?? "")) },
    ];
  },
});
import ContextMenu, { type MenuItem } from "./ContextMenu";
import LinkDialog from "./LinkDialog";

// ⌘1–⌘6 for overskrifter, ⌘0 for brødtekst, Tab/⇧Tab som indrykning i lister.
// Tab sluges altid, så fokus ikke hopper ud af editoren.
const EditorShortcuts = Extension.create({
  name: "editorShortcuts",
  addKeyboardShortcuts() {
    const shortcuts: Record<string, () => boolean> = {
      "Mod-0": () => this.editor.chain().focus().setParagraph().run(),
      Tab: () =>
        this.editor.chain().focus().sinkListItem("listItem").run() ||
        this.editor.chain().focus().sinkListItem("taskItem").run() ||
        this.editor.commands.goToNextCell() ||
        true,
      "Shift-Tab": () =>
        this.editor.chain().focus().liftListItem("listItem").run() ||
        this.editor.chain().focus().liftListItem("taskItem").run() ||
        this.editor.commands.goToPreviousCell() ||
        true,
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
  const rootRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);

  const editor = useEditor({
    extensions: [
      StarterKit,
      EditorShortcuts,
      ClaudeHighlight,
      MarkdownExtras,
      VaultImage.configure({ allowBase64: true }),
      TightTaskList,
      TaskItem.configure({ nested: true }),
      Table,
      TableRow,
      TableCell,
      TableHeader,
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
      handlePaste: (view, event) => {
        const items = event.clipboardData?.items;
        if (!items) return false;
        for (const item of Array.from(items)) {
          if (item.type.startsWith("image/")) {
            const file = item.getAsFile();
            if (!file) continue;
            event.preventDefault();
            void saveClipboardImage(file).then((rel) => {
              if (!rel) return;
              const imageType = view.state.schema.nodes.image;
              if (!imageType) return;
              view.dispatch(
                view.state.tr.replaceSelectionWith(imageType.create({ src: rel }))
              );
            });
            return true;
          }
        }
        return false;
      },
    },
    onUpdate: ({ editor }) => {
      useStore.getState().editContent(path, getMarkdown(editor));
    },
  });

  // gendan scrollposition fra sidst fanen var åben og gem den løbende;
  // rAF venter på første layout (og på autofocus, der ellers ville vinde)
  useEffect(() => {
    if (!editor) return;
    const scroller = rootRef.current?.querySelector<HTMLElement>(".layout-scroll");
    if (!scroller) return;
    const saved = getScroll(path, "layout");
    if (saved !== undefined) {
      requestAnimationFrame(() => {
        scroller.scrollTop = saved;
      });
    }
    const onScroll = () => saveScroll(path, "layout", scroller.scrollTop);
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      saveScroll(path, "layout", scroller.scrollTop);
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [editor, path]);

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
          label: "Tjekliste",
          action: () => editor.chain().focus().toggleTaskList().run(),
        },
        {
          label: "Citat",
          action: () => editor.chain().focus().toggleBlockquote().run(),
        },
        {
          label: "Faktaboks",
          action: () =>
            editor
              .chain()
              .focus()
              .insertContent(
                "<blockquote><p>[!fakta] Overskrift</p><p>Tekst …</p></blockquote>"
              )
              .run(),
        },
        ...(editor.isActive("table")
          ? [
              {
                label: "Række under",
                action: () => editor.chain().focus().addRowAfter().run(),
              },
              {
                label: "Kolonne til højre",
                action: () => editor.chain().focus().addColumnAfter().run(),
              },
              {
                label: "Slet række",
                action: () => editor.chain().focus().deleteRow().run(),
              },
              {
                label: "Slet kolonne",
                action: () => editor.chain().focus().deleteColumn().run(),
              },
              {
                label: "Slet tabel",
                action: () => editor.chain().focus().deleteTable().run(),
              },
            ]
          : [
              {
                label: "Tabel",
                action: () =>
                  editor
                    .chain()
                    .focus()
                    .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
                    .run(),
              },
            ]),
        { label: "Link …", action: () => setLinkOpen(true) },
      ]
    : [];

  return (
    <div
      className="layout-editor"
      ref={rootRef}
      onKeyDown={(e) => {
        if (e.metaKey && !e.ctrlKey && !e.altKey && e.key === "k") {
          e.preventDefault();
          setLinkOpen(true);
        }
      }}
      onClick={(e) => {
        const wikilink = (e.target as HTMLElement).closest(".wikilink");
        if (wikilink && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          const target = wikilink.getAttribute("data-target");
          if (target) void useStore.getState().openWikilink(target);
          return;
        }
        const anchor = (e.target as HTMLElement).closest("a");
        if (anchor && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          const href = anchor.getAttribute("href");
          if (href) void openUrl(href);
        }
      }}
      onContextMenu={(e) => {
        // uden markering: lad systemets menu (med staveforslag) vinde —
        // undtagen i tabeller, hvor menuen har række/kolonne-handlinger
        if (!editor) return;
        if (editor.state.selection.empty && !editor.isActive("table")) return;
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
