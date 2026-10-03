import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "../store";

// Kort, diskret besked nederst over status-/værktøjslinjen. Teksten kommer fra
// store.notice (showNotice), som rydder sig selv efter et par sekunder; taps
// går igennem beskeden.
const LEAVE_MS = 180;
// sikkerhedsnet, hvis en besked aldrig bliver ryddet
export const NOTICE_FALLBACK_MS = 10_000;

// above: bundlinje i samme .app, beskeden skal holde fri af (måles, fordi
// den ikke ligger lige under beskeden, fx notelistens fod)
export default function Notice({ above }: { above?: string }) {
  const raw: unknown = useStore((s) => s.notice);
  const text = typeof raw === "string" && raw.trim() ? raw : null;
  const [shown, setShown] = useState<string | null>(text);
  const [leaving, setLeaving] = useState(false);
  const [lift, setLift] = useState<number | null>(null);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const anchorRef = useRef<HTMLDivElement>(null);

  // den sidste besked bliver stående, mens den toner ud
  useEffect(() => {
    if (!text && shownRef.current === null) return;
    if (text) {
      setShown(text);
      setLeaving(false);
    } else {
      setLeaving(true);
    }
    const wait = text ? NOTICE_FALLBACK_MS : 0;
    const leave = text ? window.setTimeout(() => setLeaving(true), wait) : 0;
    const gone = window.setTimeout(() => {
      setShown(null);
      setLeaving(false);
    }, wait + LEAVE_MS);
    return () => {
      window.clearTimeout(leave);
      window.clearTimeout(gone);
    };
  }, [text]);

  useLayoutEffect(() => {
    if (!text || !above) return;
    const measure = () => {
      const bar = anchorRef.current?.closest(".app")?.querySelector<HTMLElement>(above);
      setLift(bar && bar.offsetHeight > 0 ? bar.offsetHeight : null);
    };
    measure();
    // tastaturet kan skjule eller vise linjen, mens beskeden står der
    window.addEventListener("resize", measure);
    window.addEventListener("mw-keyboard", measure);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("mw-keyboard", measure);
    };
  }, [text, above]);

  return (
    <div
      ref={anchorRef}
      className="notice-anchor"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {shown && (
        <div
          key={shown}
          className={"notice" + (leaving ? " leaving" : "")}
          style={lift !== null ? { marginBottom: lift + 10 } : undefined}
        >
          {shown}
        </div>
      )}
    </div>
  );
}
