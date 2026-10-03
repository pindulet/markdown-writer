import { useEffect, useRef, useState } from "react";
import { useEditor, EditorContent, Extension, type Editor, type JSONContent } from "@tiptap/react";
import { Plugin, PluginKey, Selection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { findWrapping } from "@tiptap/pm/transform";
import { openUrl } from "../backend";
import { useStore, type Doc } from "../store";
import { useIsMobile } from "../useIsMobile";
import { getScroll, saveScroll } from "../scrollMemory";
import { changedBlockIndices, splitBlocks } from "../diff";
import { resolveImageSrc, saveClipboardImage } from "../images";
import {
  createPreserver,
  getMarkdown,
  joinFrontmatter,
  splitFrontmatter,
  type Preserver,
} from "../markdownPreserve";
import {
  nextHeading,
  notifyEditor,
  openLinkTarget,
  registerEditor,
  useEditableMode,
  type EditorCommands,
} from "../editorCommands";
import { schemaExtensions } from "./layoutExtensions";
import { GhostSuggest } from "./ghostSuggest";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import LinkDialog from "./LinkDialog";
import "../mobile-editor.css";

// Indrykning deles af Tab/⇧Tab og mobilens værktøjslinje
function sinkItem(editor: Editor): boolean {
  return (
    editor.chain().focus().sinkListItem("listItem").run() ||
    editor.chain().focus().sinkListItem("taskItem").run()
  );
}

function liftItem(editor: Editor): boolean {
  return (
    editor.chain().focus().liftListItem("listItem").run() ||
    editor.chain().focus().liftListItem("taskItem").run()
  );
}

// Markdown har ingen indrykning af almindelige afsnit (forreste mellemrum
// bliver til kodeblok), så et afsnit bliver i stedet et listepunkt.
// Aldrig i en tabelcelle: GFM-celler rummer kun én linje tekst.
function paragraphToList(editor: Editor): boolean {
  return (
    editor.isActive("paragraph") &&
    !editor.isActive("listItem") &&
    !editor.isActive("taskItem") &&
    !editor.isActive("table") &&
    editor.chain().focus().toggleBulletList().run()
  );
}

// Faktaboks som Obsidian-callout: "> [!fakta] Overskrift" og brødteksten på
// linjen under (samme afsnit, hårdt linjeskift). Markeret tekst i én blok
// bliver brødteksten med sin formatering. Over flere blokke (eller ⌘A, et
// markeret billede) pakkes de markerede blokke uændret ind i boksen under
// overskriftslinjen, så intet indhold eller formatering går tabt.
function insertCallout(editor: Editor): boolean {
  const { selection } = editor.state;
  const { $from, $to, empty } = selection;
  const hardBreak: JSONContent = { type: "hardBreak" };
  const title: JSONContent = { type: "text", text: "[!fakta] Overskrift" };
  if (empty || ($from.sameParent($to) && $from.parent.isTextblock)) {
    const body: JSONContent[] = empty
      ? [{ type: "text", text: "Tekst …" }]
      : ($from.parent.content.cut($from.parentOffset, $to.parentOffset).toJSON() ?? []);
    return editor
      .chain()
      .focus()
      .insertContentAt(
        { from: selection.from, to: selection.to },
        { type: "blockquote", content: [{ type: "paragraph", content: [title, hardBreak, ...body] }] }
      )
      .run();
  }
  const from = $from.depth ? $from.before(1) : selection.from;
  const to = $to.depth ? $to.after(1) : selection.to;
  return editor
    .chain()
    .focus()
    .command(({ tr, state }) => {
      const heading = state.schema.nodes.paragraph.create(null, state.schema.text(title.text ?? ""));
      tr.insert(from, heading);
      const range = tr.doc.resolve(from + 1).blockRange(tr.doc.resolve(to + heading.nodeSize - 1));
      const wrapping = range && findWrapping(range, state.schema.nodes.blockquote);
      if (!range || !wrapping) return false;
      tr.wrap(range, wrapping);
      return true;
    })
    .run();
}

function headingLevel(editor: Editor): number {
  for (let level = 1; level <= 6; level++) {
    if (editor.isActive("heading", { level })) return level;
  }
  return 0;
}

// Fokus uden at noten hopper: står markøren uden for det synlige, flyttes
// den til starten af den øverste synlige linje
function focusInView(editor: Editor) {
  const { view } = editor;
  const scroller = view.dom.closest<HTMLElement>(".layout-scroll");
  try {
    if (scroller && !caretVisible(editor, scroller)) {
      const box = scroller.getBoundingClientRect();
      const content = view.dom.getBoundingClientRect();
      const style = getComputedStyle(view.dom);
      const hit = view.posAtCoords({
        left: content.left + (parseFloat(style.paddingLeft) || 0) + 1,
        top: Math.max(box.top, content.top + (parseFloat(style.paddingTop) || 0)) + 12,
      });
      if (hit) {
        const sel = Selection.near(view.state.doc.resolve(hit.pos));
        view.dispatch(view.state.tr.setSelection(sel));
      }
    }
  } catch {
    // kunne ikke måle (fx skjult editor): behold markeringen
  }
  view.focus();
}

function caretVisible(editor: Editor, scroller: HTMLElement): boolean {
  const caret = editor.view.coordsAtPos(editor.state.selection.head);
  const box = scroller.getBoundingClientRect();
  return caret.top >= box.top && caret.bottom <= box.bottom;
}

// ⌘1–⌘6 for overskrifter, ⌘0 for brødtekst, Tab/⇧Tab som indrykning i lister
// (Tab i et almindeligt afsnit gør det til et listepunkt).
// Tab sluges altid, så fokus ikke hopper ud af editoren.
const EditorShortcuts = Extension.create({
  name: "editorShortcuts",
  // over kernens Enter-håndtering, så tabel-reglerne nedenfor vinder
  priority: 1000,
  addKeyboardShortcuts() {
    const shortcuts: Record<string, () => boolean> = {
      "Mod-0": () => this.editor.chain().focus().setParagraph().run(),
      // Enter i en tabelcelle må aldrig dele cellen i afsnit — det knækker
      // GFM-rækken på disken. Hop til næste celle i stedet (ny række til sidst).
      Enter: () => {
        if (!this.editor.isActive("table")) return false;
        return (
          this.editor.commands.goToNextCell() ||
          this.editor.chain().focus().addRowAfter().goToNextCell().run() ||
          true
        );
      },
      "Shift-Enter": () => this.editor.isActive("table"),
      // afsnit → listepunkt; næste Tab rykker det ind, ⇧Tab gør det til tekst igen
      Tab: () =>
        sinkItem(this.editor) ||
        this.editor.commands.goToNextCell() ||
        paragraphToList(this.editor) ||
        true,
      "Shift-Tab": () =>
        liftItem(this.editor) || this.editor.commands.goToPreviousCell() || true,
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

export default function LayoutEditor({ doc }: { doc: Doc }) {
  const path = doc.path;
  const rootRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  // markeringen, da link-dialogen blev åbnet (iOS sætter ellers markøren i starten)
  const linkRange = useRef<{ from: number; to: number } | null>(null);
  // Frontmatter føres udenom editoren. `loaded.content` er det, editoren
  // senest har indlæst eller selv udsendt (`shown` uden frontmatter); er
  // doc.content noget andet, er noten ændret udefra. Preserveren bevarer
  // urørte blokkes originaltekst fra den indlæste tekst (`body`).
  const [initial] = useState(() => splitFrontmatter(doc.content));
  const loaded = useRef({ content: doc.content, shown: initial.body, ...initial });
  const preserver = useRef<Preserver | null>(null);
  // Mobil: læsetilstand, til man trykker "Rediger"; desktop altid redigerbar
  const mobile = useIsMobile();
  const editing = useStore((s) => s.editing);
  const editorRef = useRef<Editor | null>(null);
  const checkedBox = useRef<HTMLInputElement | null>(null);

  // Afkrydsning i læsetilstand uden at åbne tastaturet. TaskItem giver kun
  // den node, punktet blev oprettet med, så punktet findes via afkrydsnings-
  // feltet (fanget i capture-fasen, før TaskItem selv reagerer).
  const checkReadOnly = (checked: boolean): boolean => {
    const ed = editorRef.current;
    const item = checkedBox.current?.closest("li");
    checkedBox.current = null;
    if (!ed || ed.isDestroyed || !item) return false;
    let pos = -1;
    ed.state.doc.descendants((node, p) => {
      if (pos >= 0) return false;
      if (node.type.name === "taskItem" && ed.view.nodeDOM(p) === item) {
        pos = p;
        return false;
      }
    });
    const node = pos >= 0 ? ed.state.doc.nodeAt(pos) : null;
    if (!node) return false;
    // onUpdate gemmer som ved et tastetryk
    ed.view.dispatch(ed.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked }));
    return true;
  };

  const editor = useEditor({
    extensions: [
      ...schemaExtensions({
        resolveImageSrc,
        taskItem: { onReadOnlyChecked: (_node, checked) => checkReadOnly(checked) },
      }),
      EditorShortcuts,
      ClaudeHighlight,
      GhostSuggest.configure({ path }),
    ],
    content: initial.body,
    // tastaturet må ikke springe op, når man åbner en note for at læse den
    autofocus: mobile ? false : "end",
    editable: !mobile || editing,
    editorProps: {
      attributes: {
        class: "layout-content",
        spellcheck: "true",
        autocorrect: "on",
        autocapitalize: "on",
        lang: "da",
      },
      // lidt luft om markøren over tastaturet og værktøjslinjen
      ...(mobile ? { scrollThreshold: 24, scrollMargin: 24 } : {}),
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
      const md = getMarkdown(editor);
      preserver.current ??= createPreserver(loaded.current.body);
      const shown = preserver.current.apply(md);
      const content = joinFrontmatter(loaded.current.frontmatter, shown);
      loaded.current = { ...loaded.current, content, shown };
      useStore.getState().editContent(path, content);
    },
    // forbered bevaringen, inden der skrives (ellers sker det ved første tastetryk)
    onFocus: () => {
      window.setTimeout(() => preserver.current?.warm(), 0);
    },
  });
  editorRef.current = editor;

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onChange = (e: Event) => {
      if (e.target instanceof HTMLInputElement && e.target.type === "checkbox") {
        checkedBox.current = e.target;
      }
    };
    root.addEventListener("change", onChange, true);
    return () => root.removeEventListener("change", onChange, true);
  }, []);

  // "Rediger" giver fokus inden for trykket (så tastaturet kommer op) uden
  // at noten hopper; "Færdig" lukker tastaturet
  useEditableMode(editor, (editable, toggled) => {
    if (!editor || editor.isDestroyed) return;
    if (editor.isEditable !== editable) editor.setEditable(editable, false);
    if (!toggled) return;
    if (editable) focusInView(editor);
    else editor.commands.blur();
  });

  // tastaturet er kommet op (viewport.ts): markøren kan nu ligge bag det
  useEffect(() => {
    if (!editor) return;
    const onKeyboard = (e: Event) => {
      if (!(e as CustomEvent<boolean>).detail || !editor.isFocused) return;
      requestAnimationFrame(() => {
        if (!editor.isDestroyed) editor.commands.scrollIntoView();
      });
    };
    window.addEventListener("mw-keyboard", onKeyboard);
    return () => window.removeEventListener("mw-keyboard", onKeyboard);
  }, [editor]);

  const openLink = () => {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    linkRange.current = { from, to };
    setLinkOpen(true);
  };
  const openLinkRef = useRef(openLink);
  openLinkRef.current = openLink;

  // genskab markeringen fra før dialogen, før der indsættes eller fokuseres
  const restoreLinkRange = () => {
    const saved = linkRange.current;
    linkRange.current = null;
    if (!editor || !saved) return;
    const size = editor.state.doc.content.size;
    editor.commands.setTextSelection({
      from: Math.min(saved.from, size),
      to: Math.min(saved.to, size),
    });
  };

  // værktøjslinjen på mobil
  useEffect(() => {
    if (!editor) return;
    const run = (fn: () => void) => () => {
      if (editor.isEditable) fn();
    };
    const commands: EditorCommands = {
      kind: "layout",
      bold: run(() => editor.chain().focus().toggleBold().run()),
      italic: run(() => editor.chain().focus().toggleItalic().run()),
      heading: run(() => {
        const next = nextHeading(headingLevel(editor));
        if (next) editor.chain().focus().setHeading({ level: next as 1 | 2 | 3 }).run();
        else editor.chain().focus().setParagraph().run();
      }),
      // en liste i en tabelcelle ville knække GFM-rækken
      bulletList: run(() => {
        if (!editor.isActive("table")) editor.chain().focus().toggleBulletList().run();
      }),
      taskList: run(() => {
        if (!editor.isActive("table")) editor.chain().focus().toggleTaskList().run();
      }),
      indent: run(() => {
        if (!editor.isActive("table")) sinkItem(editor) || paragraphToList(editor);
      }),
      outdent: run(() => liftItem(editor)),
      link: run(() => openLinkRef.current()),
      undo: run(() => editor.chain().focus().undo().run()),
      redo: run(() => editor.chain().focus().redo().run()),
      blur: () => editor.commands.blur(),
      table: {
        addRowAfter: run(() => editor.chain().focus().addRowAfter().run()),
        addColumnAfter: run(() => editor.chain().focus().addColumnAfter().run()),
        deleteRow: run(() => editor.chain().focus().deleteRow().run()),
        deleteColumn: run(() => editor.chain().focus().deleteColumn().run()),
        deleteTable: run(() => editor.chain().focus().deleteTable().run()),
      },
      state: () => ({
        bold: editor.isActive("bold"),
        italic: editor.isActive("italic"),
        heading: headingLevel(editor),
        bulletList: editor.isActive("bulletList"),
        taskList: editor.isActive("taskList"),
        inTable: editor.isActive("table"),
        canUndo: editor.can().undo(),
        canRedo: editor.can().redo(),
        focused: editor.isFocused,
      }),
    };
    const unregister = registerEditor(commands);
    editor.on("transaction", notifyEditor);
    editor.on("focus", notifyEditor);
    editor.on("blur", notifyEditor);
    return () => {
      editor.off("transaction", notifyEditor);
      editor.off("focus", notifyEditor);
      editor.off("blur", notifyEditor);
      unregister();
    };
  }, [editor]);

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

  // ekstern opdatering (Claude, synk, fortryd) skrives ind i editoren
  useEffect(() => {
    if (!editor) return;
    if (doc.content !== loaded.current.content) {
      const { frontmatter, body } = splitFrontmatter(doc.content);
      if (body === loaded.current.shown) {
        // kun frontmatter er ændret: editoren (og markøren) får lov at være
        loaded.current = { ...loaded.current, content: doc.content, frontmatter };
      } else {
        loaded.current = { content: doc.content, shown: body, frontmatter, body };
        editor.commands.setContent(body, false);
        preserver.current = null;
      }
    }
    preserver.current ??= createPreserver(loaded.current.body, getMarkdown(editor));
  }, [doc.content, editor]);

  // fremhæv de blokke, Claude har ændret, mens banneret vises
  useEffect(() => {
    if (!editor) return;
    let indices: number[] = [];
    if (doc.showExternalBanner && doc.prevContent !== null) {
      const body = splitFrontmatter(doc.content).body;
      const blocks = splitBlocks(body);
      // kun når markdown-blokke og topniveau-noder er 1:1, ellers udelades fremhævning
      if (editor.state.doc.childCount === blocks.length) {
        indices = changedBlockIndices(splitFrontmatter(doc.prevContent).body, body);
      }
    }
    editor.view.dispatch(editor.state.tr.setMeta(claudeHighlightKey, indices));
  }, [doc.content, doc.prevContent, doc.showExternalBanner, editor]);

  const applyLink = (url: string) => {
    if (!editor) return;
    restoreLinkRange();
    if (editor.state.selection.empty) {
      editor
        .chain()
        .focus()
        .insertContent({ type: "text", text: url, marks: [{ type: "link", attrs: { href: url } }] })
        .run();
    } else {
      editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    }
  };

  const closeLink = () => {
    setLinkOpen(false);
    // mobil: tilbage i teksten, hvor man var, så tastaturet bliver oppe
    if (linkRange.current && mobile && editor?.isEditable) {
      restoreLinkRange();
      editor.view.focus();
    }
    linkRange.current = null;
  };

  const inTable = !!editor?.isActive("table");
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
        // lister og citater kan ikke stå i en tabelcelle (GFM: én linje)
        ...(inTable
          ? []
          : [
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
              { label: "Faktaboks", action: () => insertCallout(editor) },
            ]),
        ...(inTable
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
        { label: "Link …", action: openLink },
      ]
    : [];

  return (
    <div
      className="layout-editor"
      ref={rootRef}
      onKeyDown={(e) => {
        if (e.metaKey && !e.ctrlKey && !e.altKey && e.key === "k") {
          e.preventDefault();
          openLink();
        }
      }}
      onClick={(e) => {
        // læsetilstand (kun mobil): et tryk åbner links; ellers ⌘-klik
        const reading = !!editor && !editor.isEditable;
        const wikilink = (e.target as HTMLElement).closest(".wikilink");
        if (wikilink && (reading || e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          const target = wikilink.getAttribute("data-target");
          if (target) void useStore.getState().openWikilink(target);
          return;
        }
        const anchor = (e.target as HTMLElement).closest("a");
        if (anchor && reading) {
          // appen må aldrig selv navigere væk
          e.preventDefault();
          const href = anchor.getAttribute("href");
          if (href) openLinkTarget(href);
          return;
        }
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
      {linkOpen && <LinkDialog onClose={closeLink} onSubmit={applyLink} />}
    </div>
  );
}
