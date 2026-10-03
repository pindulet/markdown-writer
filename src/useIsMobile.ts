import { useSyncExternalStore } from "react";

// Mobillayout (noteliste og editor hver for sig i fuld skærm): smal skærm,
// eller en telefon på tværs (bred, men lav og uden mus). Medieforespørgslens
// højde er layout-viewporten, som ikke skrumper, når tastaturet åbner. En
// iPad er højere end 500 px på begge leder, og en Mac har pointer: fine, så
// ingen af dem rammes; desktop-vinduet kan ikke blive så smalt (minWidth 760
// i tauri.conf.json).
const QUERY = "(max-width: 700px), (pointer: coarse) and (max-height: 500px)";

function mediaQuery(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(QUERY)
    : null;
}

export function isMobileNow(): boolean {
  return mediaQuery()?.matches ?? false;
}

function subscribe(onChange: () => void): () => void {
  const mq = mediaQuery();
  if (!mq) return () => {};
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, isMobileNow, () => false);
}

// sidebarVisible betyder to ting: på mobil "listen vises i stedet for noten",
// på desktop "kolonnen vises". Ved et skift mellem layoutene (fx en iPad i
// Split View) returneres den nye værdi, eller null for ingen ændring. Fra en
// åben mobilnote til desktop vises kolonnen (der er ingen knap til at vise den
// igen uden tastatur); skiftes der tilbage, uden at noget er ændret imens,
// åbnes noten igen, så brugeren ikke smides ud i listen.
export function sidebarOnLayoutSwitch(
  toMobile: boolean,
  state: { sidebarVisible: boolean; hasNote: boolean },
  memo: { reopenNote: boolean }
): boolean | null {
  const reopen = memo.reopenNote;
  memo.reopenNote = false;
  if (!toMobile) {
    if (state.sidebarVisible) return null;
    memo.reopenNote = state.hasNote;
    return true;
  }
  return reopen && state.sidebarVisible && state.hasNote ? false : null;
}
