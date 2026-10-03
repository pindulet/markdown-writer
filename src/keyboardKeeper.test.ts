// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keepKeyboard, releaseKeyboard } from "./keyboardKeeper";

// Editorernes DOM efterlignes: TipTap giver .ProseMirror, CodeMirror .cm-content,
// begge med contenteditable="true", når de kan redigeres
function mountEditor(kind: "prosemirror" | "codemirror", editable = true): HTMLElement {
  const area = document.createElement("div");
  area.className = "editor-area";
  const el = document.createElement("div");
  el.className = kind === "prosemirror" ? "ProseMirror layout-content" : "cm-content";
  el.setAttribute("contenteditable", editable ? "true" : "false");
  area.appendChild(el);
  document.body.appendChild(area);
  return el;
}

function holders(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>("input[aria-hidden='true']"));
}

// MutationObserver-tilbagekald kører som mikroopgaver
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  releaseKeyboard();
  vi.useRealTimers();
});

describe("keepKeyboard", () => {
  it("giver straks (inden for trykket) fokus til et usynligt felt, iOS ikke zoomer ind på", () => {
    const dialogInput = document.createElement("input");
    document.body.appendChild(dialogInput);
    dialogInput.focus();

    keepKeyboard();

    const [holder] = holders();
    expect(holder).toBeDefined();
    expect(document.activeElement).toBe(holder);
    expect(holder.tabIndex).toBe(-1);
    expect(holder.getAttribute("aria-hidden")).toBe("true");
    expect(holder.style.position).toBe("fixed");
    expect(holder.style.opacity).toBe("0");
    expect(holder.style.fontSize).toBe("16px");
  });

  it("flytter fokus til den nye notes layout-editor, når den er monteret og redigerbar", async () => {
    keepKeyboard();
    await flush();
    const editor = mountEditor("prosemirror");
    await flush();

    expect(document.activeElement).toBe(editor);
    expect(holders()).toEqual([]);
  });

  it("venter på, at markdown-editoren bliver redigerbar", async () => {
    keepKeyboard();
    const editor = mountEditor("codemirror", false);
    await flush();
    expect(document.activeElement).not.toBe(editor);
    expect(holders()).toHaveLength(1);

    editor.setAttribute("contenteditable", "true");
    await flush();
    expect(document.activeElement).toBe(editor);
    expect(holders()).toEqual([]);
  });

  it("springer en editor over, der allerede fandtes (den forrige note)", async () => {
    const old = mountEditor("prosemirror");
    keepKeyboard();
    await flush();
    expect(document.activeElement).not.toBe(old);

    old.parentElement!.remove();
    const fresh = mountEditor("prosemirror");
    await flush();
    expect(document.activeElement).toBe(fresh);
  });

  it("ignorerer redigerbare felter uden for .editor-area", async () => {
    keepKeyboard();
    const other = document.createElement("div");
    other.className = "ProseMirror";
    other.setAttribute("contenteditable", "true");
    document.body.appendChild(other);
    await flush();
    expect(document.activeElement).not.toBe(other);
    expect(holders()).toHaveLength(1);
  });

  it("giver op efter et par sekunder: feltet mister fokus (tastaturet lukker) og fjernes", async () => {
    vi.useFakeTimers();
    keepKeyboard();
    const [holder] = holders();
    vi.advanceTimersByTime(2100);
    expect(document.activeElement).not.toBe(holder);
    expect(holders()).toEqual([]);

    // en editor, der dukker op senere, stjæler ikke fokus
    vi.useRealTimers();
    const editor = mountEditor("prosemirror");
    await flush();
    expect(document.activeElement).not.toBe(editor);
  });

  it("stopper, hvis brugeren selv flytter fokus imens", async () => {
    keepKeyboard();
    const search = document.createElement("input");
    document.body.appendChild(search);
    search.focus();
    await flush();
    expect(holders()).toEqual([]);

    const editor = mountEditor("prosemirror");
    await flush();
    expect(document.activeElement).toBe(search);
    expect(editor).toBeDefined();
  });

  it("efterlader kun ét felt, når den kaldes flere gange", () => {
    keepKeyboard();
    keepKeyboard();
    expect(holders()).toHaveLength(1);
    expect(document.activeElement).toBe(holders()[0]);
  });

  it("releaseKeyboard rydder op med det samme (fx når noten ikke kunne oprettes)", async () => {
    keepKeyboard();
    releaseKeyboard();
    expect(holders()).toEqual([]);
    const editor = mountEditor("prosemirror");
    await flush();
    expect(document.activeElement).not.toBe(editor);
  });
});
