// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

const mocks = vi.hoisted(() => ({
  mobile: true,
  resolveCreate: null as (() => void) | null,
  rejectCreate: null as ((e: Error) => void) | null,
}));

vi.mock("../useIsMobile", () => ({ isMobileNow: () => mocks.mobile }));

vi.mock("../store", async () => {
  const { create } = await import("zustand");
  const useStore = create(() => ({
    dirs: [] as string[],
    folder: "/noter",
    newNoteDir: "",
    editing: false,
    sidebarVisible: true,
    newNote: vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          mocks.resolveCreate = resolve;
          mocks.rejectCreate = reject;
        })
    ),
    setEditing: (editing: boolean) => useStore.setState({ editing }),
    setSidebarVisible: (sidebarVisible: boolean) => useStore.setState({ sidebarVisible }),
  }));
  return { useStore };
});

import NewNoteDialog from "./NewNoteDialog";
import { releaseKeyboard } from "../keyboardKeeper";
import { useStore } from "../store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;

function Harness() {
  const [open, setOpen] = useState(true);
  return open ? createElement(NewNoteDialog, { onClose: () => setOpen(false) }) : null;
}

function typeName(value: string) {
  const input = host.querySelector<HTMLInputElement>(".dialog-input")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function clickCreate() {
  const btn = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Opret")!;
  btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

// den nye notes editor, som App monterer, når noten er åben
function mountEditor(): HTMLElement {
  const area = document.createElement("div");
  area.className = "editor-area";
  const el = document.createElement("div");
  el.className = "ProseMirror";
  el.setAttribute("contenteditable", "true");
  area.appendChild(el);
  document.body.appendChild(area);
  return el;
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(async () => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(Harness)));
});

afterEach(() => {
  act(() => root.unmount());
  releaseKeyboard();
  mocks.mobile = true;
  useStore.setState({ editing: false, sidebarVisible: true });
});

describe("NewNoteDialog", () => {
  it("mobil: tastaturet holdes oppe, når dialogen lukker, og den nye note får fokus", async () => {
    const dialogInput = host.querySelector<HTMLInputElement>(".dialog-input")!;
    dialogInput.focus();
    act(() => typeName("Indkøb"));
    act(() => clickCreate());

    // dialogen er væk, men et felt har stadig fokus (iOS lukker ellers tastaturet)
    expect(host.querySelector(".dialog")).toBeNull();
    const active = document.activeElement as HTMLElement;
    expect(active).not.toBe(document.body);
    expect(active.tagName).toBe("INPUT");
    expect(active.getAttribute("aria-hidden")).toBe("true");

    await act(async () => mocks.resolveCreate!());
    expect(useStore.getState().editing).toBe(true);
    expect(useStore.getState().sidebarVisible).toBe(false);

    const editor = mountEditor();
    await flush();
    expect(document.activeElement).toBe(editor);
    expect(document.querySelector("input[aria-hidden='true']")).toBeNull();
  });

  it("mobil: tastaturet slippes, hvis noten ikke kunne oprettes", async () => {
    host.querySelector<HTMLInputElement>(".dialog-input")!.focus();
    act(() => typeName("Indkøb"));
    act(() => clickCreate());
    expect(document.querySelector("input[aria-hidden='true']")).not.toBeNull();

    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => mocks.rejectCreate!(new Error("Noten kunne ikke oprettes")));
    await flush();
    expect(document.querySelector("input[aria-hidden='true']")).toBeNull();
    expect(document.activeElement).toBe(document.body);
    expect(useStore.getState().editing).toBe(false);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("desktop: ingen usynlig tastatur-holder", () => {
    mocks.mobile = false;
    host.querySelector<HTMLInputElement>(".dialog-input")!.focus();
    act(() => typeName("Indkøb"));
    act(() => clickCreate());
    expect(document.querySelector("input[aria-hidden='true']")).toBeNull();
    void mocks.resolveCreate!();
  });
});
