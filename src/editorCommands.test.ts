// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { EditorView } from "@codemirror/view";
import type { Doc } from "./store";

// Store og backend erstattes af små udgaver, så testen hverken afhænger af
// Tauri eller af web-backenden
const mocks = vi.hoisted(() => ({
  openUrl: vi.fn(async (_url: string) => {}),
  openWikilink: vi.fn(async (_target: string) => {}),
  editContent: vi.fn((_path: string, _content: string) => {}),
}));

vi.mock("./backend", () => ({
  platform: "mock",
  openUrl: mocks.openUrl,
  resolveAsset: (p: string) => p,
  saveImage: async () => null,
  suggestCompletion: async () => "",
}));

vi.mock("./store", async () => {
  const { create } = await import("zustand");
  const useStore = create(() => ({
    editing: false,
    folder: "/noter",
    activePath: null,
    docs: {},
    aiEnabled: false,
    aiAvailable: false,
    aiModel: "claude-haiku-4-5",
    editContent: mocks.editContent,
    openWikilink: mocks.openWikilink,
  }));
  return { useStore };
});

import { useStore } from "./store";
import { Editor as CoreEditor } from "@tiptap/core";
import { getMarkdown } from "./markdownPreserve";
import { schemaExtensions } from "./components/layoutExtensions";
import LayoutEditor from "./components/LayoutEditor";
import MarkdownEditor from "./components/MarkdownEditor";
import FormatToolbar from "./components/FormatToolbar";
import {
  EMPTY_TOOLBAR_STATE,
  getActiveEditor,
  getEditorSnapshot,
  linkTarget,
  nextHeading,
  notifyEditor,
  openLinkTarget,
  registerEditor,
  subscribeEditor,
  watchEditable,
  type EditorCommands,
  type ToolbarState,
} from "./editorCommands";

// jsdom kan ikke måle tekst; editorerne skal bare kunne spørge
const emptyRect = () =>
  ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} }) as DOMRect;
Range.prototype.getClientRects = function () {
  return [] as unknown as DOMRectList;
};
Range.prototype.getBoundingClientRect = emptyRect;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function setMobile(mobile: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: mobile,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function fakeCommands(state: Partial<ToolbarState> = {}): EditorCommands & { current: ToolbarState } {
  const noop = () => {};
  const cmds = {
    kind: "markdown" as const,
    current: { ...EMPTY_TOOLBAR_STATE, ...state },
    bold: noop,
    italic: noop,
    heading: noop,
    bulletList: noop,
    taskList: noop,
    indent: noop,
    outdent: noop,
    link: noop,
    undo: noop,
    redo: noop,
    blur: noop,
    state: () => cmds.current,
  };
  return cmds;
}

describe("registret", () => {
  it("registrerer, giver besked ved ændringer og afregistrerer", () => {
    const calls: number[] = [];
    const stop = subscribeEditor(() => calls.push(1));
    const a = fakeCommands();
    const unregisterA = registerEditor(a);
    expect(getActiveEditor()).toBe(a);
    expect(getEditorSnapshot().commands).toBe(a);
    expect(calls).toHaveLength(1);

    // uændret tilstand: ingen ny besked, samme snapshot
    const before = getEditorSnapshot();
    notifyEditor();
    expect(calls).toHaveLength(1);
    expect(getEditorSnapshot()).toBe(before);

    a.current = { ...a.current, bold: true, inTable: true };
    notifyEditor();
    expect(calls).toHaveLength(2);
    expect(getEditorSnapshot().state.bold).toBe(true);
    expect(getEditorSnapshot().state.inTable).toBe(true);

    // en ny editor monteres, før den gamle når at afregistrere
    const b = fakeCommands();
    const unregisterB = registerEditor(b);
    unregisterA();
    expect(getActiveEditor()).toBe(b);
    unregisterB();
    expect(getActiveEditor()).toBeNull();
    expect(getEditorSnapshot().state).toEqual(EMPTY_TOOLBAR_STATE);
    stop();
  });

  it("uden lyttere (desktop) læses tilstanden først, når nogen spørger", () => {
    const cmds = fakeCommands();
    const state = vi.spyOn(cmds, "state");
    const unregister = registerEditor(cmds);
    state.mockClear();
    for (let i = 0; i < 5; i++) notifyEditor();
    expect(state).not.toHaveBeenCalled();
    cmds.current = { ...cmds.current, italic: true };
    expect(getEditorSnapshot().state.italic).toBe(true);
    expect(state).toHaveBeenCalledTimes(1);
    getEditorSnapshot();
    expect(state).toHaveBeenCalledTimes(1);
    unregister();
  });

  it("en editor, der fejler ved læsning af tilstand, giver tom tilstand", () => {
    const broken = fakeCommands();
    broken.state = () => {
      throw new Error("ødelagt");
    };
    const unregister = registerEditor(broken);
    expect(getEditorSnapshot().state).toEqual(EMPTY_TOOLBAR_STATE);
    unregister();
  });

  it("overskrift cykler H1 → H2 → H3 → brødtekst", () => {
    expect([0, 1, 2, 3, 4, 6].map(nextHeading)).toEqual([1, 2, 3, 0, 0, 0]);
  });
});

describe("links på mobil", () => {
  it("afgør, hvad et link åbner", () => {
    expect(linkTarget("https://github.com/x")).toEqual({ kind: "url", url: "https://github.com/x" });
    expect(linkTarget("mailto:a@b.dk")).toEqual({ kind: "url", url: "mailto:a@b.dk" });
    expect(linkTarget("www.dr.dk")).toEqual({ kind: "url", url: "https://www.dr.dk" });
    expect(linkTarget("Mappe/Min%20note.md")).toEqual({ kind: "note", name: "Min note" });
    expect(linkTarget("../Andet/Æble.MD#afsnit")).toEqual({ kind: "note", name: "Æble" });
    expect(linkTarget("Uden endelse")).toEqual({ kind: "note", name: "Uden endelse" });
    expect(linkTarget("mdwriter:///Users/k/Vault/Note%20%C3%A6.md")).toEqual({
      kind: "note",
      name: "Note æ",
    });
    expect(linkTarget("#overskrift")).toBeNull();
    expect(linkTarget("bilag.pdf")).toBeNull();
    expect(linkTarget("Møde 12.3")).toEqual({ kind: "note", name: "Møde 12.3" });
    expect(linkTarget("javascript:alert(1)")).toBeNull();
    expect(linkTarget("file:///etc/passwd")).toBeNull();
    expect(linkTarget("")).toBeNull();
  });

  it("åbner url'er udenfor og noter i appen", () => {
    openLinkTarget("https://example.com");
    openLinkTarget("Note.md");
    openLinkTarget("javascript:void(0)");
    expect(mocks.openUrl.mock.calls).toEqual([["https://example.com"]]);
    expect(mocks.openWikilink.mock.calls).toEqual([["Note"]]);
    mocks.openUrl.mockClear();
    mocks.openWikilink.mockClear();
  });
});

describe("læse-/redigeringstilstand", () => {
  afterEach(() => useStore.setState({ editing: false }));

  it("desktop er altid redigerbar", () => {
    const apply = vi.fn();
    const stop = watchEditable(false, apply);
    useStore.setState({ editing: true });
    useStore.setState({ editing: false });
    expect(apply.mock.calls).toEqual([[true, false]]);
    stop();
  });

  it("mobil skifter synkront med store.editing", () => {
    const apply = vi.fn();
    const stop = watchEditable(true, apply);
    expect(apply.mock.calls).toEqual([[false, false]]);
    useStore.setState({ editing: true });
    expect(apply.mock.calls).toEqual([
      [false, false],
      [true, true],
    ]);
    useStore.setState({ editing: true });
    useStore.setState({ editing: false });
    expect(apply.mock.calls.at(-1)).toEqual([false, true]);
    expect(apply).toHaveBeenCalledTimes(3);
    stop();
    useStore.setState({ editing: true });
    expect(apply).toHaveBeenCalledTimes(3);
  });
});

describe("layoutExtensions", () => {
  it("relative links med mappe overlever; farlige skemaer afvises stadig", () => {
    const src =
      "[a](Mappe/Min%20note.md) [b](2024/Note.md) [c](Note.md) [d](https://x.dk) [e](javascript:alert(1))";
    const editor = new CoreEditor({ extensions: schemaExtensions(), content: src, injectCSS: false });
    const hrefs = Array.from(editor.view.dom.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["Mappe/Min%20note.md", "2024/Note.md", "Note.md", "https://x.dk"]);
    expect(getMarkdown(editor)).toContain("[a](Mappe/Min%20note.md) [b](2024/Note.md)");
    editor.destroy();
  });
});

// ---------- editorerne i jsdom ----------

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function makeDoc(content: string): Doc {
  return {
    path: "/noter/Test.md",
    content,
    baseContent: content,
    dirty: false,
    claudeUpdated: false,
    showExternalBanner: false,
    prevContent: null,
    externalContent: null,
    conflict: null,
    lastSavedAt: null,
    lastExternalAt: null,
    missing: false,
  };
}

async function renderToolbar() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(FormatToolbar));
  });
}

async function render(component: typeof LayoutEditor | typeof MarkdownEditor, content: string) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const doc = makeDoc(content);
  useStore.setState({ docs: { [doc.path]: doc } });
  await act(async () => {
    root!.render(createElement(component, { doc }));
  });
  // TipTaps autofokus og CodeMirrors måling venter en omgang
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

async function cleanup() {
  if (root) {
    const r = root;
    await act(async () => r.unmount());
  }
  root = null;
  container?.remove();
  container = null;
  useStore.setState({ editing: false });
  mocks.editContent.mockClear();
  mocks.openUrl.mockClear();
  mocks.openWikilink.mockClear();
}

function layoutEditor(): Editor {
  const dom = container!.querySelector(".ProseMirror") as unknown as { editor: Editor };
  return dom.editor;
}

function saved(): string {
  const calls = mocks.editContent.mock.calls;
  return calls.length ? calls[calls.length - 1][1] : "";
}

function textPos(editor: Editor, needle: string): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found >= 0 || !node.isText || !node.text?.includes(needle)) return;
    found = pos + node.text.indexOf(needle);
  });
  if (found < 0) throw new Error(`fandt ikke "${needle}"`);
  return found;
}

function commands(): EditorCommands {
  const cmds = getActiveEditor();
  if (!cmds) throw new Error("ingen editor registreret");
  return cmds;
}

function click(el: Element): boolean {
  return el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

describe("LayoutEditor", () => {
  afterEach(cleanup);

  it("desktop: redigerbar med autofokus, uanset store.editing", async () => {
    setMobile(false);
    await render(LayoutEditor, "Hej verden\n");
    const editor = layoutEditor();
    expect(editor.isEditable).toBe(true);
    expect(document.activeElement).toBe(editor.view.dom);
    act(() => useStore.setState({ editing: false }));
    expect(editor.isEditable).toBe(true);
    expect(container!.querySelector(".tableWrapper")).toBeNull();
  });

  it("mobil: læsetilstand uden fokus; Rediger giver fokus inden for trykket", async () => {
    setMobile(true);
    await render(LayoutEditor, "Hej verden\n");
    const editor = layoutEditor();
    expect(editor.isEditable).toBe(false);
    expect(editor.view.dom.getAttribute("contenteditable")).toBe("false");
    expect(document.activeElement).not.toBe(editor.view.dom);

    act(() => {
      useStore.setState({ editing: true });
      // før React overhovedet har genrenderet
      expect(editor.isEditable).toBe(true);
      expect(document.activeElement).toBe(editor.view.dom);
    });

    await act(async () => {
      useStore.setState({ editing: false });
      await new Promise((r) => requestAnimationFrame(r));
    });
    expect(editor.isEditable).toBe(false);
    expect(document.activeElement).not.toBe(editor.view.dom);
    expect(mocks.editContent).not.toHaveBeenCalled();
  });

  it("mobil: tjekbokse kan afkrydses i læsetilstand og gemmes", async () => {
    setMobile(true);
    await render(LayoutEditor, "# Indkøb\n\n- [ ] Mælk\n- [ ] Brød\n\nSlut\n");
    const boxes = container!.querySelectorAll<HTMLInputElement>('li input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    expect(Array.from(boxes).map((b) => b.ariaLabel)).toEqual(["Ikke afkrydset", "Ikke afkrydset"]);
    act(() => boxes[1].click());
    expect(saved()).toBe("# Indkøb\n\n- [ ] Mælk\n- [x] Brød\n\nSlut\n");
    expect(boxes[1].ariaLabel).toBe("Afkrydset");
    // samme boks igen: TaskItem giver her en forældet node
    act(() => boxes[1].click());
    expect(saved()).toBe("# Indkøb\n\n- [ ] Mælk\n- [ ] Brød\n\nSlut\n");
    act(() => boxes[0].click());
    expect(saved()).toBe("# Indkøb\n\n- [x] Mælk\n- [ ] Brød\n\nSlut\n");
    expect(boxes[0].checked).toBe(true);
    expect(layoutEditor().isEditable).toBe(false);
  });

  it("mobil: tryk på links i læsetilstand åbner dem; i redigering ikke", async () => {
    setMobile(true);
    await render(
      LayoutEditor,
      "Se [[Anden note]], [GitHub](https://github.com) og [lokal](Mappe/Min%20note.md).\n"
    );
    const wikilink = container!.querySelector(".wikilink")!;
    const anchors = container!.querySelectorAll("a");
    expect(click(wikilink)).toBe(false);
    expect(click(anchors[0])).toBe(false);
    expect(click(anchors[1])).toBe(false);
    expect(mocks.openWikilink.mock.calls).toEqual([["Anden note"], ["Min note"]]);
    expect(mocks.openUrl.mock.calls).toEqual([["https://github.com"]]);

    act(() => useStore.setState({ editing: true }));
    mocks.openUrl.mockClear();
    click(anchors[0]);
    expect(mocks.openUrl).not.toHaveBeenCalled();
  });

  it("værktøjslinjens kommandoer", async () => {
    setMobile(true);
    useStore.setState({ editing: true });
    await render(LayoutEditor, "Hej verden\n\nAndet afsnit\n");
    const editor = layoutEditor();
    const cmds = commands();
    expect(cmds.kind).toBe("layout");
    act(() => {
      editor.commands.setTextSelection(textPos(editor, "verden"));
    });

    act(() => cmds.heading());
    expect(saved()).toBe("# Hej verden\n\nAndet afsnit\n");
    expect(getEditorSnapshot().state.heading).toBe(1);
    act(() => cmds.heading());
    act(() => cmds.heading());
    expect(saved()).toBe("### Hej verden\n\nAndet afsnit\n");
    act(() => cmds.heading());
    expect(saved()).toBe("Hej verden\n\nAndet afsnit\n");
    expect(getEditorSnapshot().state.heading).toBe(0);

    // ryk ind: afsnit → punkt; ryk ud: tilbage til tekst
    act(() => cmds.indent());
    expect(saved()).toBe("- Hej verden\n\nAndet afsnit\n");
    expect(getEditorSnapshot().state.bulletList).toBe(true);
    act(() => cmds.outdent());
    expect(saved()).toBe("Hej verden\n\nAndet afsnit\n");

    act(() => cmds.taskList());
    expect(saved()).toBe("- [ ] Hej verden\n\nAndet afsnit\n");
    act(() => cmds.taskList());

    const from = textPos(editor, "Hej");
    act(() => {
      editor.commands.setTextSelection({ from, to: from + 3 });
    });
    act(() => cmds.bold());
    expect(saved()).toBe("**Hej** verden\n\nAndet afsnit\n");
    expect(getEditorSnapshot().state.bold).toBe(true);
    expect(getEditorSnapshot().state.canUndo).toBe(true);
    act(() => cmds.undo());
    expect(saved()).toBe("Hej verden\n\nAndet afsnit\n");

    // i læsetilstand gør knapperne intet
    act(() => useStore.setState({ editing: false }));
    mocks.editContent.mockClear();
    act(() => cmds.bold());
    expect(mocks.editContent).not.toHaveBeenCalled();
  });

  it("tabelhandlinger, når markøren står i en tabel", async () => {
    setMobile(true);
    useStore.setState({ editing: true });
    await render(LayoutEditor, "Før\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nEfter\n");
    expect(container!.querySelector(".tableWrapper table")).not.toBeNull();
    const editor = layoutEditor();
    const cmds = commands();
    act(() => {
      editor.commands.setTextSelection(textPos(editor, "Før"));
    });
    expect(getEditorSnapshot().state.inTable).toBe(false);
    act(() => cmds.indent()); // ryk ind uden for tabel og liste: punkt
    act(() => cmds.outdent());
    act(() => {
      editor.commands.setTextSelection(textPos(editor, "1"));
    });
    expect(getEditorSnapshot().state.inTable).toBe(true);
    mocks.editContent.mockClear();
    // aldrig en liste i en celle
    act(() => cmds.indent());
    act(() => cmds.bulletList());
    act(() => cmds.taskList());
    expect(mocks.editContent).not.toHaveBeenCalled();
    expect(editor.isActive("bulletList") || editor.isActive("taskList")).toBe(false);
    act(() => cmds.table!.addRowAfter());
    expect(saved().match(/^\|/gm)).toHaveLength(4);
    act(() => cmds.table!.addColumnAfter());
    expect(saved()).toContain("| 1 |");
    expect(saved().split("\n")[2].split("|")).toHaveLength(5);
    act(() => cmds.table!.deleteTable());
    expect(saved()).not.toContain("|");
    expect(getEditorSnapshot().state.inTable).toBe(false);
  });

  it("frontmatter uden afsluttende linjeskift: første tastetryk giver en gyldig fil", async () => {
    setMobile(false);
    await render(LayoutEditor, "---\ntags: møde\n---");
    act(() => {
      layoutEditor().commands.insertContent("Hej");
    });
    expect(saved()).toBe("---\ntags: møde\n---\nHej");
  });

  function contextMenu(): string[] {
    act(() => {
      container!
        .querySelector(".layout-editor")!
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    });
    return Array.from(container!.querySelectorAll(".context-item")).map((el) => el.textContent ?? "");
  }

  function menuItem(label: string): HTMLElement {
    const found = Array.from(container!.querySelectorAll<HTMLElement>(".context-item")).find(
      (el) => el.textContent === label
    );
    if (!found) throw new Error(`intet menupunkt "${label}"`);
    return found;
  }

  it("desktop: kontekstmenuen tilbyder ikke lister, citat og faktaboks i en tabel", async () => {
    setMobile(false);
    await render(LayoutEditor, "Før\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
    const editor = layoutEditor();
    act(() => {
      editor.commands.setTextSelection({ from: textPos(editor, "Før"), to: textPos(editor, "Før") + 3 });
    });
    expect(contextMenu()).toEqual(expect.arrayContaining(["Punktliste", "Tjekliste", "Citat", "Faktaboks", "Tabel"]));
    act(() => {
      editor.commands.setTextSelection(textPos(editor, "2"));
    });
    const inTable = contextMenu();
    expect(inTable).toContain("Række under");
    for (const label of ["Punktliste", "Tjekliste", "Citat", "Faktaboks"]) expect(inTable).not.toContain(label);
  });

  it("desktop: Tab i tabellens sidste celle laver ikke en liste", async () => {
    setMobile(false);
    await render(LayoutEditor, "| a | b |\n|---|---|\n| 1 | 2 |\n");
    const editor = layoutEditor();
    act(() => {
      editor.commands.setTextSelection(textPos(editor, "2") + 1);
    });
    act(() => {
      editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    });
    expect(editor.isActive("table")).toBe(true);
    expect(editor.isActive("bulletList")).toBe(false);
  });

  it("desktop: Faktaboks laver en callout med den markerede tekst som brødtekst", async () => {
    setMobile(false);
    await render(LayoutEditor, "Første afsnit\n\nVigtig **pointe** her\n\nSidste\n");
    const editor = layoutEditor();
    const from = textPos(editor, "Vigtig");
    const to = textPos(editor, " her") + 4;
    act(() => {
      editor.commands.setTextSelection({ from, to });
    });
    contextMenu();
    act(() => {
      menuItem("Faktaboks").click();
    });
    expect(saved()).toBe("Første afsnit\n\n> [!fakta] Overskrift\n> Vigtig **pointe** her\n\nSidste\n");
    expect(container!.querySelector("blockquote.callout-fakta")).not.toBeNull();
  });

  it("desktop: Faktaboks af et helt afsnit og af flere blokke", async () => {
    setMobile(false);
    await render(LayoutEditor, "Tekst\n\nEt\n\n- to\n- tre\n\nSlut\n");
    const editor = layoutEditor();
    act(() => {
      editor.commands.setTextSelection(textPos(editor, "Tekst") + 5);
    });
    // menuen åbnes kun med en markering (uden for tabeller)
    contextMenu();
    expect(container!.querySelector(".context-item")).toBeNull();
    act(() => {
      editor.commands.setTextSelection({ from: textPos(editor, "Tekst"), to: textPos(editor, "Tekst") + 5 });
    });
    contextMenu();
    act(() => {
      menuItem("Faktaboks").click();
    });
    expect(saved()).toBe("> [!fakta] Overskrift\n> Tekst\n\nEt\n\n- to\n- tre\n\nSlut\n");
    act(() => {
      editor.commands.setTextSelection({ from: textPos(editor, "Et") + 1, to: textPos(editor, "to") + 1 });
    });
    contextMenu();
    act(() => {
      menuItem("Faktaboks").click();
    });
    // flere blokke pakkes uændret ind: listen forbliver en liste
    expect(saved()).toBe(
      "> [!fakta] Overskrift\n> Tekst\n\n> [!fakta] Overskrift\n>\n> Et\n>\n> - to\n> - tre\n\nSlut\n"
    );
  });

  it("desktop: Faktaboks over blokke med link, fed og ⌘A taber intet", async () => {
    setMobile(false);
    const src = "Et [link](https://x.dk) og **fed**\n\nTo\n";
    await render(LayoutEditor, src);
    const editor = layoutEditor();
    act(() => {
      editor.commands.selectAll();
    });
    contextMenu();
    act(() => {
      menuItem("Faktaboks").click();
    });
    expect(saved()).toBe("> [!fakta] Overskrift\n>\n> Et [link](https://x.dk) og **fed**\n>\n> To\n");
  });

  it("link-dialogen genskaber markeringen, også hvis iOS har flyttet markøren", async () => {
    setMobile(true);
    useStore.setState({ editing: true });
    await render(LayoutEditor, "Hej verden\n");
    const editor = layoutEditor();
    const from = textPos(editor, "verden");
    act(() => {
      editor.commands.setTextSelection({ from, to: from + 6 });
    });
    act(() => commands().link());
    const input = container!.querySelector<HTMLInputElement>(".dialog-input")!;
    expect(input).not.toBeNull();
    // iOS sætter markøren i starten, når dialogen tager fokus
    act(() => {
      editor.commands.setTextSelection(1);
    });
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "example.com");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const insert = Array.from(container!.querySelectorAll("button")).find(
      (b) => b.textContent === "Indsæt"
    )!;
    act(() => {
      click(insert);
    });
    expect(saved()).toBe("Hej [verden](https://example.com)\n");
    expect(container!.querySelector(".dialog-input")).toBeNull();
  });
});

describe("MarkdownEditor", () => {
  afterEach(cleanup);

  function cm(): HTMLElement {
    return container!.querySelector<HTMLElement>(".cm-content")!;
  }

  it("desktop: redigerbar, stavekontrol og fokus som før", async () => {
    setMobile(false);
    await render(MarkdownEditor, "Hej\n");
    expect(cm().getAttribute("contenteditable")).toBe("true");
    expect(cm().getAttribute("spellcheck")).toBe("true");
    expect(cm().getAttribute("autocapitalize")).toBe("on");
    expect(document.activeElement).toBe(cm());
  });

  it("mobil: læsetilstand, ingen smarte tegn, og Rediger giver fokus", async () => {
    setMobile(true);
    await render(MarkdownEditor, "Se [[Anden note]]\n");
    expect(cm().getAttribute("contenteditable")).toBe("false");
    expect(cm().getAttribute("spellcheck")).toBe("false");
    expect(cm().getAttribute("autocapitalize")).toBe("sentences");
    expect(cm().getAttribute("autocorrect")).toBe("on");
    expect(document.activeElement).not.toBe(cm());

    click(container!.querySelector(".cm-wikilink")!);
    expect(mocks.openWikilink.mock.calls).toEqual([["Anden note"]]);

    act(() => {
      useStore.setState({ editing: true });
      expect(cm().getAttribute("contenteditable")).toBe("true");
      expect(document.activeElement).toBe(cm());
    });
    mocks.openWikilink.mockClear();
    click(container!.querySelector(".cm-wikilink")!);
    expect(mocks.openWikilink).not.toHaveBeenCalled();
  });

  it("værktøjslinjens kommandoer", async () => {
    setMobile(true);
    useStore.setState({ editing: true });
    await render(MarkdownEditor, "Hej\n\n");
    const cmds = commands();
    expect(cmds.kind).toBe("markdown");
    expect(cmds.table).toBeUndefined();
    expect(getEditorSnapshot().state.canUndo).toBe(false);

    act(() => cmds.bulletList());
    expect(getEditorSnapshot().state.canUndo).toBe(true);
    act(() => cmds.undo());
    expect(saved()).toBe("Hej\n\n");
    expect(getEditorSnapshot().state.canRedo).toBe(true);

    act(() => cmds.heading());
    expect(saved()).toBe("# Hej\n\n");
    act(() => cmds.heading());
    act(() => cmds.heading());
    expect(saved()).toBe("### Hej\n\n");
    expect(getEditorSnapshot().state.heading).toBe(3);
    act(() => cmds.heading());
    expect(saved()).toBe("Hej\n\n");

    act(() => cmds.bulletList());
    expect(saved()).toBe("- Hej\n\n");
    expect(getEditorSnapshot().state.bulletList).toBe(true);
    act(() => cmds.taskList());
    expect(saved()).toBe("- [ ] Hej\n\n");
    expect(getEditorSnapshot().state.taskList).toBe(true);
    act(() => cmds.bulletList());
    expect(saved()).toBe("- Hej\n\n");
    act(() => cmds.bulletList());
    expect(saved()).toBe("Hej\n\n");
    act(() => cmds.indent());
    expect(saved()).toBe("  Hej\n\n");
    act(() => cmds.outdent());
    expect(saved()).toBe("Hej\n\n");
  });

  it("på en tom linje står markøren efter det nye mærke", async () => {
    setMobile(true);
    useStore.setState({ editing: true });
    await render(MarkdownEditor, "Hej\n\n");
    const view = EditorView.findFromDOM(container!.querySelector<HTMLElement>(".cm-editor")!)!;
    act(() => {
      view.dispatch({ selection: { anchor: view.state.doc.length } });
    });
    act(() => commands().heading());
    act(() => {
      view.dispatch(view.state.replaceSelection("Titel"));
    });
    expect(saved()).toBe("Hej\n\n# Titel");
    act(() => {
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      view.dispatch(view.state.replaceSelection("\n"));
    });
    act(() => commands().taskList());
    act(() => {
      view.dispatch(view.state.replaceSelection("Punkt"));
    });
    expect(saved()).toBe("Hej\n\n# Titel\n- [ ] Punkt");
  });
});

describe("FormatToolbar", () => {
  afterEach(cleanup);

  function button(label: string): HTMLButtonElement {
    const found = Array.from(container!.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === label || b.textContent === label
    );
    if (!found) throw new Error(`ingen knap "${label}"`);
    return found;
  }

  it("intet at vise uden en editor", async () => {
    await renderToolbar();
    expect(container!.innerHTML).toBe("");
  });

  it("knapperne kører kommandoer uden at tage fokus", async () => {
    const cmds = fakeCommands({ bold: true, canUndo: false, focused: true });
    const bold = vi.spyOn(cmds, "bold");
    const undo = vi.spyOn(cmds, "undo");
    const blur = vi.spyOn(cmds, "blur");
    const unregister = registerEditor(cmds);
    await renderToolbar();

    const labels = Array.from(container!.querySelectorAll("button")).map(
      (b) => b.getAttribute("aria-label") ?? b.textContent
    );
    expect(labels).toEqual([
      "Fed",
      "Kursiv",
      "Overskrift",
      "Punktliste",
      "Tjekliste",
      "Ryk ud",
      "Ryk ind",
      "Link",
      "Fortryd",
      "Gentag",
      "Skjul tastatur",
    ]);
    expect(button("Fed").getAttribute("aria-pressed")).toBe("true");

    const down = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
    expect(button("Fed").dispatchEvent(down)).toBe(false);
    const mouse = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    expect(button("Kursiv").dispatchEvent(mouse)).toBe(false);

    act(() => {
      click(button("Fed"));
      click(button("Fortryd")); // intet at fortryde
      click(button("Skjul tastatur"));
    });
    expect(bold).toHaveBeenCalledTimes(1);
    expect(undo).not.toHaveBeenCalled();
    expect(blur).toHaveBeenCalledTimes(1);
    act(() => unregister());
    expect(container!.innerHTML).toBe("");
  });

  it("tabelhandlinger, når markøren står i en tabel", async () => {
    const table = {
      addRowAfter: vi.fn(),
      addColumnAfter: vi.fn(),
      deleteRow: vi.fn(),
      deleteColumn: vi.fn(),
      deleteTable: vi.fn(),
    };
    const cmds = fakeCommands({ heading: 2 });
    cmds.table = table;
    const unregister = registerEditor(cmds);
    await renderToolbar();
    expect(button("Overskrift 2").textContent).toBe("H2");
    expect(() => button("Tabel")).toThrow();

    act(() => {
      cmds.current = { ...cmds.current, inTable: true };
      notifyEditor();
    });
    // lister kan ikke stå i en tabelcelle
    const bullet = vi.spyOn(cmds, "bulletList");
    const task = vi.spyOn(cmds, "taskList");
    const indent = vi.spyOn(cmds, "indent");
    for (const label of ["Punktliste", "Tjekliste", "Ryk ind"]) {
      expect(button(label).getAttribute("aria-disabled"), label).toBe("true");
      act(() => {
        click(button(label));
      });
    }
    expect(bullet).not.toHaveBeenCalled();
    expect(task).not.toHaveBeenCalled();
    expect(indent).not.toHaveBeenCalled();
    expect(button("Fed").getAttribute("aria-disabled")).toBeNull();
    act(() => {
      click(button("Tabel"));
    });
    act(() => {
      click(button("Ny række"));
      click(button("Slet kolonne"));
    });
    expect(table.addRowAfter).toHaveBeenCalledTimes(1);
    expect(table.deleteColumn).toHaveBeenCalledTimes(1);

    // markøren forlader tabellen: tilbage til formateringen
    act(() => {
      cmds.current = { ...cmds.current, inTable: false };
      notifyEditor();
    });
    expect(() => button("Ny række")).toThrow();
    expect(button("Fed")).toBeTruthy();
    act(() => unregister());
  });
});
