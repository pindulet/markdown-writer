// Web/mobil: gem og synk, når telefonen skifter app. iOS giver ingen
// pålidelig besked, når appen lukkes — kun visibilitychange — og timere
// står stille i baggrunden. Derfor gemmes alt, så snart appen skjules,
// og der synkes igen, når den kommer frem.

export interface LifecycleDeps {
  flushAll: () => Promise<unknown>;
  syncNow: () => Promise<void>;
  lastSyncAt: () => number | null;
  checkForUpdate: () => Promise<unknown>;
}

const STALE_MS = 30_000; // ældre synk end dette → synk, når appen kommer frem
const POLL_MS = 60_000; // tjek for nyt fra GitHub, mens appen er fremme (304 er gratis)

export function startLifecycle(deps: LifecycleDeps): () => void {
  const stale = () => {
    const last = deps.lastSyncAt();
    return last === null || Date.now() - last > STALE_MS;
  };
  const quietly = (p: Promise<unknown>) => void p.catch(() => {});

  const onVisibility = () => {
    if (document.visibilityState === "hidden") {
      // synk også, hvis gemningen fejlede — det, der nåede IndexedDB, skal op
      quietly(
        deps
          .flushAll()
          .catch(() => {})
          .then(() => deps.syncNow())
      );
    } else {
      if (stale()) quietly(deps.syncNow());
      quietly(deps.checkForUpdate());
    }
  };
  const onOnline = () => quietly(deps.syncNow());
  const onPageHide = () => quietly(deps.flushAll());
  const poll = window.setInterval(() => {
    if (document.visibilityState !== "visible" || navigator.onLine === false) return;
    if (stale()) quietly(deps.syncNow());
  }, POLL_MS);

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("online", onOnline);
  window.addEventListener("pagehide", onPageHide);
  return () => {
    window.clearInterval(poll);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("pagehide", onPageHide);
  };
}

// Bed browseren om ikke at rydde telefonens kopi af noterne, når pladsen
// bliver trang. Safari spørger ikke brugeren, men bedømmer selv
// (hjemmeskærms-apps får lov) — derfor spørges der ved hver start.
export function requestPersistentStorage(): void {
  try {
    void navigator.storage?.persist?.().catch(() => {});
  } catch {
    // ikke kritisk
  }
}
