import { useEffect, useState } from "react";
import { useStore, type Doc } from "../store";

function HelpButton() {
  return (
    <button
      className="help-btn"
      title="Tastaturgenveje (⌘/)"
      onClick={() => useStore.getState().setShortcutsOpen(true)}
    >
      ?
    </button>
  );
}

function countWords(text: string) {
  const words = text
    .replace(/[#*_>`\-\[\]()]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return words.length;
}

function timeLabel(ts: number) {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, "0")}.${d
    .getMinutes()
    .toString()
    .padStart(2, "0")}`;
}

function AiChip() {
  const aiEnabled = useStore((s) => s.aiEnabled);
  const aiAvailable = useStore((s) => s.aiAvailable);
  const label = !aiAvailable
    ? "AI: nøgle mangler"
    : aiEnabled
      ? "AI: til"
      : "AI: fra";
  return (
    <button
      className={`ai-chip ${aiAvailable && aiEnabled ? "ai-chip-on" : ""}`}
      title={
        aiAvailable
          ? "Automatiske skriveforslag til/fra (⇧⌘J). ⌥Tab foreslår manuelt."
          : "Klik for at indsætte din Anthropic API-nøgle"
      }
      onClick={() => useStore.getState().toggleAi()}
    >
      {label}
    </button>
  );
}

export default function StatusBar({ doc }: { doc: Doc | undefined }) {
  // genrender løbende, så "lige nu" bliver til et klokkeslæt
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  if (!doc || doc.missing) {
    return (
      <div className="status-bar">
        <span />
        <HelpButton />
      </div>
    );
  }

  const words = countWords(doc.content);
  const chars = doc.content.length;

  let right = "";
  let rightAccent = false;
  const now = Date.now();
  if (doc.conflict !== null) {
    right = "Afventer dit valg";
    rightAccent = true;
  } else if (doc.lastExternalAt && now - doc.lastExternalAt < 60_000) {
    right = "Opdateret af Claude · lige nu";
    rightAccent = true;
  } else if (doc.dirty) {
    right = "Gemmer …";
  } else if (doc.lastExternalAt && doc.lastSavedAt === null) {
    right = `Opdateret af Claude · ${timeLabel(doc.lastExternalAt)}`;
  } else if (doc.lastSavedAt) {
    right = `Gemt automatisk · ${timeLabel(doc.lastSavedAt)}`;
  } else {
    right = "Alt gemt";
  }

  return (
    <div className="status-bar">
      <span>
        {words} ord · {chars} tegn
      </span>
      <span className="status-right">
        <AiChip />
        <span className={rightAccent ? "status-accent" : ""}>{right}</span>
        <HelpButton />
      </span>
    </div>
  );
}
