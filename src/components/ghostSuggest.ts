// AI-autocomplete i layout-visningen: samme adfærd som ghostText.ts i
// markdown-visningen — gråt forslag ved markøren, Tab accepterer, Esc
// afviser, ⌥Tab beder manuelt. Bygget som TipTap/ProseMirror-plugin.

import { Extension } from "@tiptap/react";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorView } from "@tiptap/pm/view";
import { suggestCompletion } from "../backend";
import { useStore } from "../store";

const DEBOUNCE_MS = 300;
// Hele noten sendes med som kontekst; lofterne er kun et værn mod
// ekstremt lange noter, så kaldet ikke bliver dyrt og langsomt
const PREFIX_CHARS = 24000;
const SUFFIX_CHARS = 8000;

interface Ghost {
  pos: number; // hvor forslaget vises og indsættes
  anchor: number; // hvor markøren stod — midt i et ord ligger pos efter ordet
  text: string;
}

const ghostKey = new PluginKey<Ghost | null>("ghostSuggest");

function noteTitle(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/i, "");
}

export const GhostSuggest = Extension.create<{ path: string }>({
  name: "ghostSuggest",
  // over EditorShortcuts (1000), hvis Tab ellers altid sluges
  priority: 2000,

  addOptions() {
    return { path: "" };
  },

  addProseMirrorPlugins() {
    const path = this.options.path;
    // delt mutérbar tilstand mellem keydown-handler og view-hook
    const ctl = {
      timer: null as number | null,
      generation: 0,
      suppressed: false,
      inFlight: false,
    };

    const cancel = () => {
      if (ctl.timer !== null) {
        window.clearTimeout(ctl.timer);
        ctl.timer = null;
      }
    };

    const fire = async (view: EditorView, manual: boolean) => {
      const s = useStore.getState();
      if (!s.aiAvailable || (!manual && !s.aiEnabled)) return;
      if (view.composing) return;
      const { state } = view;
      const sel = state.selection;
      if (!sel.empty) return;
      const $head = sel.$head;
      if (!$head.parent.isTextblock) return;
      if ($head.parent.type.name === "codeBlock") return;
      const head = $head.pos;
      // midt i et ord: flyt forslagspunktet til ordets slutning, så
      // modellen fuldfører hele ordet og fortsætter derfra
      let pos = head;
      const paraText = $head.parent.textContent;
      const off = $head.parentOffset;
      const charBefore = off > 0 ? paraText.charAt(off - 1) : "";
      const charAfter = paraText.charAt(off);
      if (
        charBefore &&
        !/\s/.test(charBefore) &&
        charAfter &&
        !/\s/.test(charAfter)
      ) {
        const tail = paraText.slice(off, off + 40).match(/^\S+/);
        if (tail) pos = head + tail[0].length;
      }
      const prefix = state.doc.textBetween(
        Math.max(0, pos - PREFIX_CHARS),
        pos,
        "\n"
      );
      const suffix = state.doc.textBetween(
        pos,
        Math.min(state.doc.content.size, pos + SUFFIX_CHARS),
        "\n"
      );
      if (!manual) {
        if (prefix.trim().length < 20) return;
        if ($head.parent.type.name === "heading") return;
        // vent til der står noget reelt i den aktuelle blok
        const line = $head.parent.textBetween(0, $head.parentOffset);
        if (line.trim().length < 3) return;
      }
      const gen = ctl.generation;
      let text: string;
      ctl.inFlight = true;
      try {
        text = await suggestCompletion(noteTitle(path), prefix, suffix);
      } catch (e) {
        // ingen fejlboks midt i skrivningen — men statusbaren skal vise hvorfor
        s.setAiError(e instanceof Error ? e.message : String(e));
        return;
      } finally {
        ctl.inFlight = false;
      }
      s.setAiError(null);
      if (ctl.generation !== gen) return; // der er sket noget imens
      let clean = text.split("\n")[0].trimEnd();
      if (!clean) return;
      // står der et ord lige efter forslaget, skal der et mellemrum imellem
      if (/^[\p{L}\p{N}]/u.test(suffix)) clean += " ";
      if (view.state.selection.$head.pos !== head || !view.state.selection.empty)
        return;
      view.dispatch(
        view.state.tr.setMeta(ghostKey, { pos, anchor: head, text: clean })
      );
    };

    const dismiss = (view: EditorView): boolean => {
      const hadGhost = !!ghostKey.getState(view.state);
      if (!hadGhost && ctl.timer === null && !ctl.inFlight) return false;
      ctl.suppressed = true;
      ctl.generation += 1;
      cancel();
      if (hadGhost) view.dispatch(view.state.tr.setMeta(ghostKey, null));
      return true;
    };

    const accept = (view: EditorView): boolean => {
      const ghost = ghostKey.getState(view.state);
      if (!ghost) return false;
      const tr = view.state.tr.insertText(ghost.text, ghost.pos);
      tr.setSelection(TextSelection.create(tr.doc, ghost.pos + ghost.text.length));
      tr.setMeta(ghostKey, null);
      view.dispatch(tr);
      return true;
    };

    return [
      new Plugin<Ghost | null>({
        key: ghostKey,
        state: {
          init: () => null,
          apply(tr: Transaction, ghost, _old, newState: EditorState) {
            const meta = tr.getMeta(ghostKey) as Ghost | null | undefined;
            if (meta !== undefined) return meta;
            if (!ghost) return null;
            if (tr.docChanged) {
              // skriv-igennem: én ren tekstindsættelse ved forslaget, der
              // matcher dets begyndelse, forbruger den del og beholder resten.
              // Gælder kun når forslaget står ved selve markøren — et forslag
              // efter et ord (midt-i-ord) falder ved enhver redigering.
              const step = tr.steps.length === 1 ? tr.steps[0] : null;
              if (
                ghost.anchor === ghost.pos &&
                step instanceof ReplaceStep &&
                step.from === step.to &&
                step.from === ghost.pos
              ) {
                const inserted = step.slice.content.textBetween(
                  0,
                  step.slice.content.size
                );
                if (inserted && ghost.text.startsWith(inserted)) {
                  const rest = ghost.text.slice(inserted.length);
                  const moved = ghost.pos + inserted.length;
                  ghost = rest ? { pos: moved, anchor: moved, text: rest } : null;
                } else {
                  ghost = null;
                }
              } else {
                ghost = null;
              }
            }
            if (ghost && newState.selection.$head.pos !== ghost.anchor)
              return null;
            if (ghost && !newState.selection.empty) return null;
            return ghost;
          },
        },
        props: {
          decorations(state) {
            const ghost = ghostKey.getState(state);
            if (!ghost) return DecorationSet.empty;
            return DecorationSet.create(state.doc, [
              Decoration.widget(
                ghost.pos,
                () => {
                  const span = document.createElement("span");
                  span.className = "cm-ghost-text";
                  span.setAttribute("aria-hidden", "true");
                  span.textContent = ghost.text;
                  return span;
                },
                { side: 1 }
              ),
            ]);
          },
          handleKeyDown(view, event) {
            if (event.key === "Tab" && event.altKey) {
              cancel();
              void fire(view, true);
              return true;
            }
            if (event.key === "Tab") return accept(view);
            if (event.key === "Escape") return dismiss(view);
            return false;
          },
        },
        view() {
          return {
            update(view: EditorView, prevState: EditorState) {
              const docChanged = !view.state.doc.eq(prevState.doc);
              const selChanged = !view.state.selection.eq(prevState.selection);
              if (!docChanged && !selChanged) return;
              ctl.generation += 1;
              cancel();
              if (docChanged) ctl.suppressed = false;
              if (ghostKey.getState(view.state)) return; // skriv-igennem i gang
              // kun brugerens egen skrivning udløser forslag — eksterne
              // opdateringer (Claude) ankommer uden fokus
              if (!docChanged || !view.hasFocus() || ctl.suppressed) return;
              const s = useStore.getState();
              if (!s.aiEnabled || !s.aiAvailable) return;
              ctl.timer = window.setTimeout(() => {
                ctl.timer = null;
                void fire(view, false);
              }, DEBOUNCE_MS);
            },
            destroy: cancel,
          };
        },
      }),
    ];
  },
});
