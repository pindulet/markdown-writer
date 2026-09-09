// AI-autocomplete: gråt "ghost text"-forslag ved markøren.
// Tab accepterer, Esc afviser, ⌥Tab beder om et forslag manuelt.
// Automatiske forslag udløses af en skrivepause og annulleres af
// ethvert tastetryk; et forsinket svar fra et gammelt kald vises aldrig
// (generationstæller). Skriver brugeren netop det foreslåede, beholdes
// resten af forslaget.

import { Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { suggestCompletion } from "../backend";
import { useStore } from "../store";

const DEBOUNCE_MS = 300;
const PREFIX_CHARS = 2000; // kontekst før markøren, der sendes med
const SUFFIX_CHARS = 500;

interface Ghost {
  pos: number; // hvor forslaget vises og indsættes
  anchor: number; // hvor markøren stod — midt i et ord ligger pos efter ordet
  text: string;
}

const setGhost = StateEffect.define<Ghost | null>();

class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: GhostWidget) {
    return other.text === this.text;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-ghost-text";
    span.setAttribute("aria-hidden", "true");
    span.textContent = this.text;
    return span;
  }
}

const ghostField = StateField.define<Ghost | null>({
  create: () => null,
  update(ghost, tr) {
    let fromEffect = false;
    for (const effect of tr.effects) {
      if (effect.is(setGhost)) {
        ghost = effect.value;
        fromEffect = true;
      }
    }
    if (!fromEffect && ghost && tr.docChanged) {
      // skriv-igennem: én ren indsættelse ved forslaget, der matcher
      // dets begyndelse, forbruger den del og beholder resten.
      // Gælder kun når forslaget står ved selve markøren — et forslag
      // efter et ord (midt-i-ord) falder ved enhver redigering.
      let single = true;
      let count = 0;
      let inserted = "";
      const pos = ghost.pos;
      tr.changes.iterChanges((fromA, toA, _fromB, _toB, text) => {
        count += 1;
        if (fromA !== toA || fromA !== pos) single = false;
        inserted = text.toString();
      });
      if (
        ghost.anchor === ghost.pos &&
        count === 1 &&
        single &&
        inserted &&
        ghost.text.startsWith(inserted)
      ) {
        const rest = ghost.text.slice(inserted.length);
        const moved = ghost.pos + inserted.length;
        ghost = rest ? { pos: moved, anchor: moved, text: rest } : null;
      } else {
        ghost = null;
      }
    }
    if (ghost && tr.newSelection.main.head !== ghost.anchor) return null;
    return ghost;
  },
  provide: (f) =>
    EditorView.decorations.from(f, (ghost): DecorationSet =>
      ghost
        ? Decoration.set([
            Decoration.widget({ widget: new GhostWidget(ghost.text), side: 1 }).range(
              ghost.pos
            ),
          ])
        : Decoration.none
    ),
});

function acceptGhost(view: EditorView): boolean {
  const ghost = view.state.field(ghostField);
  if (!ghost) return false;
  view.dispatch({
    changes: { from: ghost.pos, insert: ghost.text },
    selection: { anchor: ghost.pos + ghost.text.length },
    effects: setGhost.of(null),
    userEvent: "input.complete",
  });
  return true;
}

// Inde i en uafsluttet ```-blok foreslås intet
function inCodeFence(prefix: string): boolean {
  const fences = prefix.match(/^(```|~~~)/gm);
  return fences !== null && fences.length % 2 === 1;
}

function noteTitle(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/i, "");
}

export function ghostText(path: string): Extension {
  const autoTrigger = ViewPlugin.fromClass(
    class {
      timer: number | null = null;
      generation = 0; // tælles op ved enhver ændring; forældede svar smides væk
      suppressed = false; // Esc: foreslå ikke igen før næste redigering
      inFlight = false;

      constructor(readonly view: EditorView) {}

      update(update: ViewUpdate) {
        if (!update.docChanged && !update.selectionSet) return;
        this.generation += 1;
        this.cancel();
        if (update.docChanged) this.suppressed = false;
        // mens et forslag stadig vises (skriv-igennem), bedes der ikke om et nyt
        if (update.state.field(ghostField)) return;
        const typed = update.transactions.some(
          (tr) => tr.isUserEvent("input.type") || tr.isUserEvent("delete")
        );
        if (typed && !this.suppressed) this.schedule();
      }

      destroy() {
        this.cancel();
      }

      cancel() {
        if (this.timer !== null) {
          window.clearTimeout(this.timer);
          this.timer = null;
        }
      }

      schedule() {
        const s = useStore.getState();
        if (!s.aiEnabled || !s.aiAvailable) return;
        this.timer = window.setTimeout(() => {
          this.timer = null;
          void this.fire(false);
        }, DEBOUNCE_MS);
      }

      dismiss(): boolean {
        // rammer både et synligt forslag, en ventende debounce og et
        // igangværende API-kald (generationen gør svaret forældet)
        const hadGhost = !!this.view.state.field(ghostField);
        if (!hadGhost && this.timer === null && !this.inFlight) return false;
        this.suppressed = true;
        this.generation += 1;
        this.cancel();
        if (hadGhost) this.view.dispatch({ effects: setGhost.of(null) });
        return true;
      }

      async fire(manual: boolean) {
        const s = useStore.getState();
        if (!s.aiAvailable || (!manual && !s.aiEnabled)) return;
        const { state } = this.view;
        if (this.view.composing) return;
        const sel = state.selection.main;
        if (!sel.empty) return;
        const head = sel.head;
        // midt i et ord: flyt forslagspunktet til ordets slutning, så
        // modellen fuldfører hele ordet og fortsætter derfra
        let pos = head;
        const charBefore = head > 0 ? state.sliceDoc(head - 1, head) : "";
        const charAfter = state.sliceDoc(
          head,
          Math.min(state.doc.length, head + 1)
        );
        if (
          charBefore &&
          !/\s/.test(charBefore) &&
          charAfter &&
          !/\s/.test(charAfter)
        ) {
          const lineEnd = state.doc.lineAt(head).to;
          const tail = state
            .sliceDoc(head, Math.min(lineEnd, head + 40))
            .match(/^\S+/);
          if (tail) pos = head + tail[0].length;
        }
        const prefix = state.sliceDoc(Math.max(0, pos - PREFIX_CHARS), pos);
        const suffix = state.sliceDoc(
          pos,
          Math.min(state.doc.length, pos + SUFFIX_CHARS)
        );
        if (inCodeFence(prefix)) return;
        if (!manual) {
          if (prefix.trim().length < 20) return;
          // vent til der står noget reelt på linjen, og lad overskrifter være
          const line = prefix.slice(prefix.lastIndexOf("\n") + 1);
          if (line.trim().length < 3) return;
          if (line.trimStart().startsWith("#")) return;
        }
        const gen = this.generation;
        let text: string;
        this.inFlight = true;
        try {
          text = await suggestCompletion(noteTitle(path), prefix, suffix);
        } catch (e) {
          // ingen fejlboks midt i skrivningen — men statusbaren skal vise hvorfor
          s.setAiError(e instanceof Error ? e.message : String(e));
          return;
        } finally {
          this.inFlight = false;
        }
        s.setAiError(null);
        if (this.generation !== gen) return; // der er sket noget imens
        let clean = text.split("\n")[0].trimEnd();
        if (!clean) return;
        // står der et ord lige efter forslaget, skal der et mellemrum imellem
        if (/^[\p{L}\p{N}]/u.test(suffix)) clean += " ";
        if (this.view.state.selection.main.head !== head) return;
        this.view.dispatch({
          effects: setGhost.of({ pos, anchor: head, text: clean }),
        });
      }
    }
  );

  const ghostKeymap = Prec.highest(
    keymap.of([
      { key: "Tab", run: acceptGhost },
      {
        key: "Escape",
        run: (view) => view.plugin(autoTrigger)?.dismiss() ?? false,
      },
      {
        key: "Alt-Tab",
        run: (view) => {
          const plugin = view.plugin(autoTrigger);
          if (!plugin) return false;
          plugin.cancel();
          void plugin.fire(true);
          return true;
        },
      },
    ])
  );

  return [ghostField, autoTrigger, ghostKeymap];
}
