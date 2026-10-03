import type { Extensions, NodeViewRenderer } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import Text from "@tiptap/extension-text";
import CodeBlock from "@tiptap/extension-code-block";
import Link from "@tiptap/extension-link";
import Image, { type ImageOptions } from "@tiptap/extension-image";
import TaskList from "@tiptap/extension-task-list";
import TaskItem, { type TaskItemOptions } from "@tiptap/extension-task-item";
import Table, { type TableOptions } from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import HardBreak from "@tiptap/extension-hard-break";
import { Markdown } from "tiptap-markdown";
import { MarkdownExtras } from "./markdownExtras";

// De extensions, der bestemmer layout-visningens skema og dermed hvordan
// markdown parses og skrives. Den synlige editor og den skjulte serializer
// i markdownPreserve.ts bygger begge på denne liste, så de altid er ens.
// Ren UI (genveje, fremhævning, AI-forslag) tilføjes af LayoutEditor.

// tiptap-markdowns (prosemirror-markdowns) serializer-tilstand, så vidt den bruges her
interface SerializerState {
  out: string;
  delim: string;
  inTable?: boolean;
  inAutolink?: boolean;
  inlines?: { start?: number; end?: number }[];
  nodes: unknown;
  marks: unknown;
  options: unknown;
  write(content?: string): void;
  text(text: string, escape?: boolean): void;
  esc(text: string, startOfLine?: boolean): string;
  ensureNewLine(): void;
  closeBlock(node: PMNode): void;
  render(node: PMNode, parent: PMNode, index: number): void;
  renderInline(node: PMNode, fromBlockStart?: boolean): void;
}

// som tiptap-markdowns tekst-serializer (html:false)
const escapeHTML = (s: string) => s.replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Det, der først på en linje ville starte en blok: punkt (-, +, *), nummer
// (1. og 1)), overskrift (#), === / --- under linjen ovenfor og en tabels
// skillelinje (|---|). Citat (>) er allerede &gt;, og ``` / ~~~ escapes altid.
function escapeLineStart(line: string): string {
  if (/^(=+|-+)[ \t]*$/.test(line) || (/^[-:|][-:| \t]*$/.test(line) && /[|:]/.test(line))) {
    return "\\" + line;
  }
  return line
    .replace(/^([-+*]|#{1,6})(?=[ \t]|$)/, "\\$1")
    .replace(/^(\d{1,9})([.)])(?=[ \t]|$)/, "$1\\$2");
}

// Tekst. Ud over tiptap-markdowns escaping:
// - et autolink (<https://…>) escapes ikke, ellers havner \ i adressen;
// - teksten efter et hårdt linjeskift står først på en linje i filen og
//   escapes derfor som en linjestart. Indledende mellemrum ignorerer markdown
//   på en fortsat linje; de fjernes, så de ikke gør linjen til liste eller kode.
//   Ikke i tabeller, hvor linjeskiftet er et mellemrum.
const LineSafeText = Text.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: SerializerState, node: PMNode, parent: PMNode, index: number) {
          const text = node.text ?? "";
          if (state.inAutolink) {
            state.text(text, false);
            return;
          }
          const afterBreak = !state.inTable && index > 0 && parent.child(index - 1).type.name === "hardBreak";
          if (!afterBreak) {
            state.text(escapeHTML(text));
            return;
          }
          const lines = escapeHTML(text)
            .split("\n")
            .map((line) => escapeLineStart(state.esc(line.replace(/^[ \t]+/, ""))));
          state.text(lines.join("\n"), false);
        },
        parse: {},
      },
    };
  },
});

// Vaulten er skrevet i Obsidian-stil, hvor et enkelt linjeskift ER et
// linjeskift (fx "> [!fakta] Titel\n> Tekst" eller "**Maria:** …\n**Ask:** …").
// Derfor parses de som hardBreak (breaks: true nedenfor) og skrives tilbage
// som et almindeligt linjeskift — ellers blev linjerne slået sammen ved gem.
// Et linjeskift lige efter et andet (eller først i afsnittet) skrives som
// "\" + linjeskift; et tomt linjeskift ville dele afsnittet.
// tiptap-markdowns egen hardBreak-serialisering falder tilbage til HTML i
// tabelceller, hvilket med html:false bliver til det bogstavelige "[hardBreak]"
// i filen. Et rigtigt linjeskift ville knække rækken, så i tabeller bliver
// linjeskift til et mellemrum.
const TableSafeHardBreak = HardBreak.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: SerializerState, node: PMNode, parent: PMNode, index: number) {
          for (let i = index + 1; i < parent.childCount; i++) {
            if (parent.child(i).type !== node.type) {
              // en tom linje (to linjeskift i træk, evt. med mellemrum imellem)
              // skrives som "\\" + linjeskift, ellers deler den afsnittet
              let k = index - 1;
              while (k >= 0 && parent.child(k).isText && !/\S/.test(parent.child(k).text ?? "")) k--;
              const emptyLine = k < 0 || parent.child(k).type === node.type;
              state.write(state.inTable ? " " : emptyLine ? "\\\n" : "\n");
              return;
            }
          }
        },
        parse: {},
      },
    };
  },
});

// Hegnet skal være længere end enhver ```-række i koden, ellers lukker
// den blokken for tidligt (tiptap-markdown skriver altid ```)
const FencedCodeBlock = CodeBlock.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: SerializerState, node: PMNode) {
          const runs = node.textContent.match(/`{3,}/g) ?? [];
          const fence = "`".repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
          state.write(fence + ((node.attrs.language as string | null) || "") + "\n");
          state.text(node.textContent, false);
          state.ensureNewLine();
          state.write(fence);
          state.closeBlock(node);
        },
      },
    };
  },
});

function imageMarkdown(state: SerializerState, attrs: { src?: string; alt?: string; title?: string }): string {
  const { src = "", alt = "", title } = attrs;
  return (
    `![${state.esc(alt ?? "")}](${(src ?? "").replace(/[()]/g, "\\$&")}` +
    (title ? ` "${title.replace(/"/g, '\\"')}"` : "") +
    ")"
  );
}

function inlineCode(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const ticks = "`".repeat(longest + 1);
  return longest ? `${ticks} ${text} ${ticks}` : `${ticks}${text}${ticks}`;
}

// En tekstbloks indhold som én linje markdown. Den skrives i en tilstand
// for sig, så cellens tekst kan efterbehandles uden at forstyrre resten.
// Mellemrummet foran står for "| " og gør, at tiptap-markdowns flytning af
// mellemrum ud af fed/kursiv sker som i resten af noten (den springer
// position 0 over); den behandling sker først ved næste render-kald.
function inlineMarkdown(state: SerializerState, node: PMNode, fromBlockStart: boolean): string {
  const Ctor = state.constructor as new (nodes: unknown, marks: unknown, options: unknown) => SerializerState;
  const sub = new Ctor(state.nodes, state.marks, state.options);
  sub.inTable = true;
  sub.out = " ";
  sub.renderInline(node, fromBlockStart);
  const empty = node.type.schema.nodes.paragraph.create();
  for (let i = 0; i < 8; i++) {
    const top = sub.inlines?.[sub.inlines.length - 1];
    if (!top?.start || !top.end) break;
    sub.render(empty, empty, 0);
  }
  return sub.out.slice(1);
}

// En celle som én linje: alle dens tekstblokke (også i lister, citater og
// indlejrede tabeller) efter hinanden med mellemrum, billeder inline og en
// vandret streg som "---" (ellers forsvandt det, man skrev).
// Et "|" i cellen ville dele den; GFM fjerner præcis én \ foran hvert |,
// også i inline-kode, så der sættes én foran hvert.
function cellMarkdown(state: SerializerState, cell: PMNode): string {
  const parts: string[] = [];
  cell.descendants((node) => {
    let part: string | null = null;
    if (node.type.name === "image") part = imageMarkdown(state, node.attrs);
    else if (node.type.name === "horizontalRule") part = "---";
    else if (node.isTextblock && node.type.spec.code) part = inlineCode(node.textContent.replace(/\r?\n/g, " "));
    else if (node.isTextblock) part = inlineMarkdown(state, node, !parts.length);
    if (part === null) return true;
    part = part.replace(/\r?\n/g, " ").trim();
    if (part) parts.push(part);
    return false;
  });
  return parts.join(" ").replace(/\|/g, "\\|");
}

// GFM-tabel, som aldrig falder tilbage til HTML (= "[table]" i filen med
// html:false): første række er altid overskrift, hver celle står på én linje,
// og kolonneantallet er det største i nogen række. En flettet celle skrives i
// sin første kolonne/række; de celler, den dækker, bliver tomme.
const MarkdownTable = Table.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: SerializerState, node: PMNode) {
          const grid: string[][] = [];
          const covered: number[] = []; // rækker tilbage, som en rowspan dækker, pr. kolonne
          node.forEach((rowNode) => {
            const cells: string[] = [];
            let col = 0;
            const skipCovered = () => {
              while (covered[col] > 0) {
                covered[col]--;
                cells[col++] = "";
              }
            };
            rowNode.forEach((cell) => {
              skipCovered();
              const colspan = Math.max(1, Number(cell.attrs.colspan) || 1);
              const rowspan = Math.max(1, Number(cell.attrs.rowspan) || 1);
              for (let k = 0; k < colspan; k++) {
                cells[col + k] = k ? "" : cellMarkdown(state, cell);
                if (rowspan > 1) covered[col + k] = rowspan - 1;
              }
              col += colspan;
            });
            for (; col < covered.length; col++) {
              if (covered[col] > 0) {
                covered[col]--;
                cells[col] = "";
              }
            }
            grid.push(cells);
          });
          const width = Math.max(1, ...grid.map((cells) => cells.length));
          const line = (cells: string[]) =>
            `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
          grid.forEach((cells, r) => {
            state.write(line(cells));
            state.ensureNewLine();
            if (r === 0) {
              state.write(line(Array(width).fill("---")));
              state.ensureNewLine();
            }
          });
          state.closeBlock(node);
        },
      },
    };
  },
});

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

const checkboxLabel = (checked: boolean) => (checked ? "Afkrydset" : "Ikke afkrydset");

// TipTap regner tjekboksens etiket ud, før boksen får sin tilstand, så et
// afkrydset punkt hed "Ikke afkrydset", til det blev ændret. Ren visning.
const LabeledTaskItem = TaskItem.extend({
  addNodeView() {
    const create = this.parent?.() as NodeViewRenderer;
    return (props) => {
      const view = create(props);
      const box = (view.dom as HTMLElement).querySelector?.<HTMLInputElement>('input[type="checkbox"]');
      if (box) box.ariaLabel = checkboxLabel(!!props.node.attrs.checked);
      return view;
    };
  },
});

interface VaultImageOptions extends ImageOptions {
  resolveSrc: (src: string) => string;
}

// Billeder gemmes med relativ sti i markdown; kun visningen slås op
// gennem asset-protokollen (resolveSrc).
const VaultImage = Image.extend<VaultImageOptions>({
  addOptions() {
    return {
      ...(this.parent?.() as ImageOptions),
      resolveSrc: (src: string) => src,
    };
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "img",
      { ...HTMLAttributes, src: this.options.resolveSrc(String(HTMLAttributes.src ?? "")) },
    ];
  },
  // billedet er en blok, men tiptap-markdown skriver det som inline uden at
  // afslutte blokken, så afsnittet efter blev klistret på: ![a](b.png)Tekst
  addStorage() {
    return {
      markdown: {
        serialize(state: SerializerState, node: PMNode) {
          state.write(imageMarkdown(state, node.attrs));
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },
});

// TipTaps link-tjek afviser relative stier med mappe (`[x](Mappe/Note.md)`:
// i dens regex bliver `.-:` et tegnområde, der også rummer "/"), så linket
// forsvandt fra visningen og fra filen ved gem. Stier uden skema er ufarlige;
// alt med skema går stadig gennem TipTaps eget tjek.
// Ukendte skemaer (fx x-apple-data-detectors:// fra kopieret mail) bevares
// også — disken er sandheden; kun skemaer, der kan køre kode, afvises.
function isAllowedUri(url: string, ctx: { defaultValidate: (url: string) => boolean }) {
  // browsere ignorerer blanktegn og kontroltegn i skemaet ("java\tscript:")
  // eslint-disable-next-line no-control-regex
  const bare = url.replace(/[\x00-\x20\s]/g, "");
  return ctx.defaultValidate(url) || !/^(javascript|vbscript|data):/i.test(bare);
}

// Indstillinger, der kun påvirker visning og betjening — aldrig hvordan
// markdown parses eller skrives (ellers er den skjulte serializer ikke
// længere en tro kopi af den synlige editor). Fx taskItem.onReadOnlyChecked
// (afkrydsning i mobilens læsetilstand).
export interface SchemaOptions {
  resolveImageSrc?: (src: string) => string;
  taskItem?: Partial<TaskItemOptions>;
  table?: Partial<TableOptions>;
}

export function schemaExtensions(opts: SchemaOptions = {}): Extensions {
  return [
    StarterKit.configure({ hardBreak: false, text: false, codeBlock: false }),
    LineSafeText,
    TableSafeHardBreak,
    FencedCodeBlock,
    MarkdownExtras,
    VaultImage.configure({
      allowBase64: true,
      ...(opts.resolveImageSrc ? { resolveSrc: opts.resolveImageSrc } : {}),
    }),
    TightTaskList,
    LabeledTaskItem.configure({
      ...opts.taskItem,
      nested: true,
      // TipTap giver kun den node, punktet blev oprettet med, så punktets
      // tekst ville blive forældet; VoiceOver læser den op alligevel
      a11y: { checkboxLabel: (_node, checked) => checkboxLabel(checked) },
    }),
    // wrapperen (div.tableWrapper) gør brede tabeller vandret rulbare i
    // stedet for at sprænge kolonnen; kolonnebredder trækkes ikke med musen
    MarkdownTable.configure({ renderWrapper: true, resizable: false, ...opts.table }),
    TableRow,
    TableCell,
    TableHeader,
    Link.configure({ openOnClick: false, autolink: true, isAllowedUri }),
    Markdown.configure({
      html: false,
      breaks: true,
      transformPastedText: true,
      transformCopiedText: true,
    }),
  ];
}
