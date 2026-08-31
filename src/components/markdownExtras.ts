import { Extension } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";

export const WIKILINK_PATTERN = /\[\[([^\][\n]+)\]\]/g;
const CALLOUT_PATTERN = /^\[!([a-zA-ZæøåÆØÅ]+)\]/;

// Kendte callout-typer får hver sin farve; alt andet falder tilbage til accent
const KNOWN_CALLOUTS = new Set([
  "fakta",
  "info",
  "note",
  "tip",
  "advarsel",
  "warning",
  "vigtigt",
  "important",
]);

function buildDecorations(doc: PMNode): Decoration[] {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      for (const match of node.text.matchAll(WIKILINK_PATTERN)) {
        const from = pos + (match.index ?? 0);
        decos.push(
          Decoration.inline(from, from + match[0].length, {
            class: "wikilink",
            "data-target": match[1],
          })
        );
      }
    }
    if (node.type.name === "blockquote") {
      const first = node.firstChild;
      if (first && first.type.name === "paragraph") {
        const match = first.textContent.match(CALLOUT_PATTERN);
        if (match) {
          const type = match[1].toLowerCase();
          const cls = KNOWN_CALLOUTS.has(type) ? `callout callout-${type}` : "callout";
          decos.push(Decoration.node(pos, pos + node.nodeSize, { class: cls }));
          const markerFrom = pos + 2; // ind i blockquote (+1) og ind i afsnittet (+1)
          decos.push(
            Decoration.inline(markerFrom, markerFrom + match[0].length, {
              class: "callout-marker",
            })
          );
        }
      }
    }
  });
  return decos;
}

// Wikilinks ([[Note]]) og callout-bokse (> [!fakta]) vises pænt i layout view
// uden at røre selve markdown-indholdet — det er ren dekoration.
export const MarkdownExtras = Extension.create({
  name: "markdownExtras",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("markdownExtras"),
        props: {
          decorations(state) {
            return DecorationSet.create(state.doc, buildDecorations(state.doc));
          },
        },
      }),
    ];
  },
});
