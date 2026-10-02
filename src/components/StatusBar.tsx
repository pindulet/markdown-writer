import { useEffect, useState } from "react";
import { AI_MODELS, useStore, type AiModel, type Doc } from "../store";

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
  const aiLastError = useStore((s) => s.aiLastError);
  const failed = aiAvailable && aiEnabled && aiLastError !== null;
  const label = !aiAvailable
    ? "AI: nøgle mangler"
    : failed
      ? "AI: fejl"
      : aiEnabled
        ? "AI: til"
        : "AI: fra";
  return (
    <button
      className={`ai-chip ${failed ? "ai-chip-error" : aiAvailable && aiEnabled ? "ai-chip-on" : ""}`}
      title={
        !aiAvailable
          ? "Klik for at indsætte din Anthropic API-nøgle"
          : failed
            ? `Seneste forslag fejlede: ${aiLastError}`
            : "Automatiske skriveforslag til/fra (⇧⌘J). ⌥Tab foreslår manuelt."
      }
      onClick={() => useStore.getState().toggleAi()}
    >
      {label}
    </button>
  );
}

function AiModelPicker() {
  const aiModel = useStore((s) => s.aiModel);
  return (
    <select
      className="ai-chip ai-model"
      title="Model til skriveforslag"
      value={aiModel}
      onChange={(e) => useStore.getState().setAiModel(e.target.value as AiModel)}
    >
      {AI_MODELS.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label}
        </option>
      ))}
    </select>
  );
}

export default function StatusBar({ doc }: { doc: Doc | undefined }) {
  // genrender løbende, så "lige nu" bliver til et klokkeslæt
  const [, setTick] = useState(0);
  const aiOn = useStore((s) => s.aiAvailable && s.aiEnabled);
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
        {aiOn && <AiModelPicker />}
        <span className={rightAccent ? "status-accent" : ""}>{right}</span>
        <HelpButton />
      </span>
    </div>
  );
}
