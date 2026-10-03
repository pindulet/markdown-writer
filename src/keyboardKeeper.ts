// iOS åbner kun tastaturet, når et felt får fokus inden for en brugerhandling.
// En ny note monteres først, når den er oprettet (asynkront); til den tid er
// dialogens felt væk og tastaturet lukket. keepKeyboard() kaldes derfor
// SYNKRONT i trykket: et usynligt felt får fokus og holder tastaturet oppe,
// til den nye notes editor er monteret og redigerbar. Så flyttes fokus dertil
// (iOS beholder tastaturet ved et programmatisk skift fra et felt med fokus).
// Dukker der ingen editor op, gives der op, og tastaturet lukker.

const EDITOR =
  '.editor-area .ProseMirror[contenteditable="true"], .editor-area .cm-content[contenteditable="true"]';
const TIMEOUT_MS = 2000;

let release: (() => void) | null = null;

export function keepKeyboard(): void {
  const previous = release;
  const holder = document.createElement("input");
  holder.type = "text";
  holder.tabIndex = -1;
  holder.setAttribute("aria-hidden", "true");
  holder.setAttribute("autocomplete", "off");
  Object.assign(holder.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "1px",
    height: "1px",
    margin: "0",
    padding: "0",
    border: "0",
    fontSize: "16px", // under 16 px zoomer iOS ind ved fokus
    opacity: "0",
    pointerEvents: "none",
  });
  document.body.appendChild(holder);

  // editorer, der allerede findes, hører til en anden note
  const before = new Set(document.querySelectorAll(EDITOR));
  let moving = false;
  let timer = 0;

  const tryMove = () => {
    const target = Array.from(document.querySelectorAll<HTMLElement>(EDITOR)).find(
      (el) => !before.has(el)
    );
    if (!target) return;
    // tegn, brugeren nåede at skrive i det usynlige felt, flyttes med
    const typed = holder.value;
    moving = true;
    target.focus({ preventScroll: true });
    moving = false;
    if (!target.contains(document.activeElement)) return;
    if (typed) {
      try {
        document.execCommand("insertText", false, typed);
      } catch {
        // uden insertText (fx i tests) mistes kun de få tegn
      }
    }
    cleanup();
  };
  const observer = new MutationObserver(tryMove);

  // brugeren har selv flyttet fokus (eller lukket tastaturet): stop
  const onBlur = () => {
    if (!moving) cleanup();
  };

  const cleanup = () => {
    if (release !== cleanup) return;
    release = null;
    observer.disconnect();
    window.clearTimeout(timer);
    holder.removeEventListener("blur", onBlur);
    if (document.activeElement === holder) holder.blur();
    holder.remove();
  };

  // det nye felt får fokus, før det gamle fjernes, så tastaturet bliver oppe
  holder.focus({ preventScroll: true });
  previous?.();
  release = cleanup;
  holder.addEventListener("blur", onBlur);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["contenteditable"],
  });
  timer = window.setTimeout(cleanup, TIMEOUT_MS);
}

// fx når noten ikke kunne oprettes
export function releaseKeyboard(): void {
  release?.();
}
