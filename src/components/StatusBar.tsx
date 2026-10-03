import { useEffect, useState } from "react";
import { platform, type Platform } from "../backend";
import { AI_MODELS, useStore, type AiModel, type Doc, type SyncStatus } from "../store";
import { useIsMobile } from "../useIsMobile";

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

export interface SaveStatus {
  text: string;
  accent: boolean;
}

// Gem-status for den aktive note. Bruges af statuslinjen (desktop) og af
// topbarens undertekst på mobil (compact + synk-status).
export function saveStatusLabel(
  doc: Doc,
  platform: Platform,
  opts: { compact?: boolean; syncStatus?: SyncStatus; lastSyncAt?: number | null } = {}
): SaveStatus {
  // på telefonen kommer ændringer fra GitHub, ikke fra Claude på disken
  const updated = platform === "web" ? "Opdateret udefra" : "Opdateret af Claude";
  const now = Date.now();
  if (doc.conflict !== null) {
    return { text: "Afventer dit valg", accent: true };
  }
  if (doc.lastExternalAt && now - doc.lastExternalAt < 60_000) {
    return { text: `${updated} · lige nu`, accent: true };
  }
  if (doc.dirty) {
    return { text: "Gemmer …", accent: false };
  }
  const { syncStatus, lastSyncAt } = opts;
  const unsynced =
    (syncStatus === "offline" || syncStatus === "error" || syncStatus === "conflict") &&
    doc.lastSavedAt !== null &&
    (lastSyncAt == null || doc.lastSavedAt > lastSyncAt);
  if (unsynced) {
    return { text: "Gemt · ikke synket endnu", accent: true };
  }
  if (doc.lastExternalAt && doc.lastSavedAt === null) {
    return { text: `${updated} · ${timeLabel(doc.lastExternalAt)}`, accent: false };
  }
  if (doc.lastSavedAt) {
    const saved = opts.compact ? "Gemt" : "Gemt automatisk";
    return { text: `${saved} · ${timeLabel(doc.lastSavedAt)}`, accent: false };
  }
  return { text: "Alt gemt", accent: false };
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
  const mobile = useIsMobile();
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // AI-forslag findes kun på computeren; genvejsoversigten giver ingen mening
  // på en telefon
  const showAi = platform !== "web";
  const showHelp = platform !== "web" && !mobile;

  if (!doc || doc.missing) {
    return (
      <div className="status-bar">
        <span />
        {showHelp && <HelpButton />}
      </div>
    );
  }

  const words = countWords(doc.content);
  const chars = doc.content.length;
  const status = saveStatusLabel(doc, platform);

  return (
    <div className="status-bar">
      <span>
        {words} ord · {chars} tegn
      </span>
      <span className="status-right">
        {showAi && <AiChip />}
        {showAi && aiOn && <AiModelPicker />}
        <span className={status.accent ? "status-accent" : ""}>{status.text}</span>
        {showHelp && <HelpButton />}
      </span>
    </div>
  );
}
