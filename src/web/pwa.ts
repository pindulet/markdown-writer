// Web/mobil: service worker og sikker opdatering til nye versioner.
// En ny version tages først i brug, når alt er gemt i IndexedDB, og aldrig
// midt i en skrivning: straks, hvis appen lige er startet, eller ingen
// editor har fokus — ellers næste gang appen lægges i baggrunden. Kan noget
// ikke gemmes (fejl eller konflikt), venter den, til det kan.
// Hjemmeskærms-appen på iOS vender tilbage fra app-skifteren uden at
// genindlæse, så browseren tjekker ikke selv — det gør checkForUpdate.
import { registerSW } from "virtual:pwa-register";
import { platform } from "../backend";
import { useStore } from "../store";

export type UpdateCheck = "updating" | "latest" | "offline";

const JUST_STARTED_MS = 10_000;
const UPDATE_EVERY_MS = 30 * 60_000;
const RELOAD_FALLBACK_MS = 4_000;
const RETRY_MS = 30_000; // nyt forsøg, når noget ikke kunne gemmes
const PRELOAD_RELOAD_KEY = "mw.preloadReload";

let started = false;
let registration: ServiceWorkerRegistration | undefined;
let updateSW: ((reloadPage?: boolean) => Promise<void>) | null = null;
let refreshPending = false; // ny version venter på at blive taget i brug
let reloadPending = false; // ny version styrer siden; genindlæs
let applying = false;
let retryTimer: number | null = null;

// Skriver brugeren lige nu? (editor, søgefelt, dialog, nøglefeltet …)
function userIsTyping(): boolean {
  return !!document.activeElement?.closest(
    ".cm-content, .ProseMirror, input, textarea, [contenteditable='true']"
  );
}

function safeToApply(): boolean {
  return (
    document.visibilityState === "hidden" ||
    performance.now() < JUST_STARTED_MS ||
    !userIsTyping()
  );
}

// Sand = alt er gemt i IndexedDB; falsk = noget ville gå tabt ved en genindlæsning
async function flushSafely(): Promise<boolean> {
  try {
    return await useStore.getState().flushAll();
  } catch {
    return false;
  }
}

function retryLater(): void {
  if (retryTimer !== null) return;
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    void applyUpdate();
  }, RETRY_MS);
}

async function applyUpdate(force = false): Promise<void> {
  if (!refreshPending && !reloadPending) return;
  if (applying || (!force && !safeToApply())) return;
  applying = true;
  try {
    if (!(await flushSafely())) {
      retryLater(); // også ved næste skift til baggrund/forgrund
      return;
    }
    if (reloadPending) {
      location.reload();
      return;
    }
    if (!updateSW) return;
    refreshPending = false;
    await updateSW(true);
    // normalt kommer onNeedReload, når den nye version styrer siden;
    // udebliver den, genindlæses alligevel
    window.setTimeout(() => {
      reloadPending = true;
      void applyUpdate();
    }, RELOAD_FALLBACK_MS);
  } finally {
    applying = false;
  }
}

function onVisibility() {
  // i baggrunden må opdateringen gerne ske; ellers kun hvis det er sikkert
  void applyUpdate(document.visibilityState === "hidden");
}

// En gammel side kan forsøge at hente en kodefil, som den nye version har
// fjernet. Så gemmes alt, og siden genindlæses — men højst én gang ad gangen,
// så en reelt manglende fil ikke giver en løkke.
function onPreloadError(e: Event) {
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(PRELOAD_RELOAD_KEY)) || 0;
  } catch {
    // ingen sessionStorage
  }
  if (Date.now() - last < 10_000) return;
  e.preventDefault();
  try {
    sessionStorage.setItem(PRELOAD_RELOAD_KEY, String(Date.now()));
  } catch {
    // ingen sessionStorage
  }
  void reloadWhenSaved();
}

// Genindlæser siden — men aldrig med ugemt tekst. Så venter genindlæsningen,
// til alt er gemt (som en ny version). Sand = siden genindlæses nu.
export async function reloadWhenSaved(): Promise<boolean> {
  if (await flushSafely()) {
    location.reload();
    return true;
  }
  reloadPending = true;
  retryLater();
  return false;
}

export function initPwa(): void {
  if (platform !== "web" || started) return;
  started = true;
  updateSW = registerSW({
    immediate: true,
    onRegisteredSW(_url, reg) {
      registration = reg;
      if (!reg) return;
      window.setInterval(() => {
        if (document.visibilityState === "visible" && navigator.onLine) {
          reg.update().catch(() => {});
        }
      }, UPDATE_EVERY_MS);
    },
    onNeedRefresh() {
      refreshPending = true;
      void applyUpdate();
    },
    onNeedReload() {
      reloadPending = true;
      void applyUpdate();
    },
  });
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("vite:preloadError", onPreloadError);
}

// Spørg serveren, om der er en ny version. Findes der en, tages den i brug
// efter reglerne ovenfor (fra indstillingerne sker det med det samme).
export async function checkForUpdate(): Promise<UpdateCheck> {
  if (platform !== "web") return "latest";
  if (refreshPending || reloadPending) {
    void applyUpdate();
    return "updating";
  }
  if (!navigator.onLine) return "offline";
  const reg = registration;
  if (!reg) return "latest";
  try {
    await reg.update();
  } catch {
    return "offline";
  }
  if (reg.waiting) {
    // allerede hentet, men aldrig meldt (fx fra en tidligere start)
    refreshPending = true;
    void applyUpdate();
    return "updating";
  }
  return reg.installing ? "updating" : "latest";
}
