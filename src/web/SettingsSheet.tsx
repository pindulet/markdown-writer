// Web/mobil: indstillinger som bundark — forbindelse og synk, tekststørrelse,
// version, adgangsnøgle og "glem telefonens kopi".
import { useEffect, useState } from "react";
import { minZoom, useStore, type SyncStatus } from "../store";
import { clearConfig, loadConfig } from "./config";
import { pendingChangesCount, resetWebData } from "./githubBackend";
import { checkForUpdate, reloadWhenSaved, type UpdateCheck } from "./pwa";
import SetupScreen, { newTokenUrl } from "./SetupScreen";

const DAY_MS = 86_400_000;
const KEY_WARN_DAYS = 350; // nøglen laves med 366 dages levetid
const KEY_LIFETIME_DAYS = 366;
const MONTHS = ["jan.", "feb.", "mar.", "apr.", "maj", "jun.", "jul.", "aug.", "sep.", "okt.", "nov.", "dec."];
const TOKENS_URL = "https://github.com/settings/personal-access-tokens";

function clock(d: Date) {
  return `${d.getHours().toString().padStart(2, "0")}.${d.getMinutes().toString().padStart(2, "0")}`;
}

function dateLabel(d: Date) {
  return `${d.getDate()}. ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function whenLabel(ts: number) {
  const d = new Date(ts);
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay ? `kl. ${clock(d)}` : `${dateLabel(d)} kl. ${clock(d)}`;
}

function daysAgoLabel(days: number) {
  if (days <= 0) return "i dag";
  if (days === 1) return "i går";
  return `for ${days} dage siden`;
}

function syncLabel(
  status: SyncStatus,
  detail: string,
  lastSyncAt: number | null,
  progress: { done: number; total: number } | null
) {
  switch (status) {
    case "syncing":
      return progress && progress.total > 0
        ? `Henter noter … ${progress.done} af ${progress.total}`
        : "Synkroniserer …";
    case "offline":
      return "Ingen forbindelse — synker, når der er net igen";
    case "conflict":
    case "error":
      return detail || "Synk mislykkedes";
    default:
      return lastSyncAt ? `Synket ${whenLabel(lastSyncAt)}` : "Ikke synket endnu";
  }
}

function notesLabel(n: number) {
  return n === 1 ? "1 note" : `${n} noter`;
}

const UPDATE_TEXT: Record<UpdateCheck | "checking", string> = {
  checking: "Søger …",
  latest: "Du har den nyeste version",
  updating: "Ny version hentes …",
  offline: "Kunne ikke søge — er du på nettet?",
};

function buildLabel() {
  const t = new Date(__BUILD_TIME__);
  const built = Number.isNaN(t.getTime()) ? __BUILD_TIME__ : `${dateLabel(t)} kl. ${clock(t)}`;
  return `Version ${__APP_VERSION__} · bygget ${built}`;
}

export default function SettingsSheet({ onClose }: { onClose: () => void }) {
  const syncStatus = useStore((s) => s.syncStatus);
  const syncDetail = useStore((s) => s.syncDetail);
  const lastSyncAt = useStore((s) => s.lastSyncAt);
  const syncProgress = useStore((s) => s.syncProgress);
  const zoom = useStore((s) => s.zoom);
  const [cfg, setCfg] = useState(loadConfig);
  const [pending, setPending] = useState<number | null>(null);
  const [update, setUpdate] = useState<UpdateCheck | "checking" | null>(null);
  const [changingKey, setChangingKey] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  const [forgetError, setForgetError] = useState<string | null>(null);

  // optælles, når arket åbnes, og igen efter hver synk
  useEffect(() => {
    if (syncStatus === "syncing") return;
    let cancelled = false;
    void useStore
      .getState()
      .flushAll()
      .then(() => pendingChangesCount())
      .then((n) => {
        if (!cancelled) setPending(n);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [syncStatus, confirmForget]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !changingKey) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, changingKey]);

  const searchUpdate = async () => {
    setUpdate("checking");
    setUpdate(await checkForUpdate());
  };

  const forget = async () => {
    setForgetting(true);
    setForgetError(null);
    try {
      await resetWebData();
    } catch (e) {
      setForgetError(`Det lykkedes ikke at glemme noterne: ${e instanceof Error ? e.message : String(e)}`);
      setForgetting(false);
      return;
    }
    clearConfig();
    try {
      // sessionen peger på noter, der ikke findes længere
      for (const key of ["mw.folder", "mw.tabs", "mw.active"]) localStorage.removeItem(key);
      sessionStorage.removeItem("mw.mobileEditor");
    } catch {
      // ikke kritisk
    }
    location.reload();
  };

  if (changingKey && cfg) {
    return (
      <SetupScreen
        initial={{ owner: cfg.owner, repo: cfg.repo, branch: cfg.branch }}
        onCancel={() => setChangingKey(false)}
        onConnected={() => {
          // genindlæs, når alt er gemt i IndexedDB. Kan noget ikke gemmes nu,
          // venter genindlæsningen — synken bruger den nye nøgle alligevel.
          void reloadWhenSaved().then((reloading) => {
            if (reloading) return;
            setCfg(loadConfig());
            setChangingKey(false);
            useStore.getState().showNotice("Ny nøgle gemt");
            void useStore.getState().syncNow();
          });
        }}
      />
    );
  }

  const keyDays = cfg?.connectedAt ? Math.floor((Date.now() - cfg.connectedAt) / DAY_MS) : null;
  const keyExpired = keyDays !== null && keyDays >= KEY_LIFETIME_DAYS;
  const keyExpiring = keyDays !== null && keyDays > KEY_WARN_DAYS;
  const keyRejected = syncStatus === "error" && /nøgle/i.test(syncDetail);
  const syncing = syncStatus === "syncing";

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div
        className="settings-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Indstillinger"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-grabber" />
        <div className="settings-head">
          <div className="settings-title">
            {confirmForget ? "Glem noterne på denne telefon?" : "Indstillinger"}
          </div>
          {!confirmForget && (
            <button className="settings-done" onClick={onClose}>
              Færdig
            </button>
          )}
        </div>

        {confirmForget ? (
          <div className="settings-section">
            <p className="settings-text">
              Telefonens kopi af noterne og adgangsnøglen slettes. Noterne på GitHub og på
              computeren røres ikke.
            </p>
            {pending !== null && pending > 0 && (
              <p className="settings-alert">
                Ændringer i {notesLabel(pending)} er ikke sendt til GitHub endnu — de går tabt,
                hvis du fortsætter. Har du net, så tryk Annuller og Synkronisér nu først.
              </p>
            )}
            {forgetError && <p className="settings-alert">{forgetError}</p>}
            <div className="settings-buttons">
              <button
                className="settings-btn settings-btn-danger"
                disabled={forgetting}
                onClick={() => void forget()}
              >
                {forgetting
                  ? "Glemmer …"
                  : pending
                    ? "Glem noterne alligevel"
                    : "Glem noterne"}
              </button>
              <button
                className="settings-btn"
                disabled={forgetting}
                onClick={() => setConfirmForget(false)}
              >
                Annuller
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="settings-section">
              <div className="settings-section-title">Noter på GitHub</div>
              <div className="settings-group">
                <div className="settings-row">
                  <div className="settings-row-main">
                    <div>{cfg ? `${cfg.owner}/${cfg.repo}` : "Ikke forbundet"}</div>
                    {cfg && <div className="settings-sub">Branch: {cfg.branch}</div>}
                  </div>
                </div>
                <div className="settings-row">
                  <div className="settings-row-main">
                    <div className={syncStatus === "error" || syncStatus === "conflict" ? "settings-warn-text" : ""}>
                      {syncLabel(syncStatus, syncDetail, lastSyncAt, syncProgress)}
                    </div>
                    {pending !== null && (
                      <div className="settings-sub">
                        {pending === 0
                          ? "Alt er sendt til GitHub"
                          : `Ændringer i ${notesLabel(pending)} venter på at blive sendt`}
                      </div>
                    )}
                  </div>
                </div>
                <button
                  className="settings-row settings-action"
                  disabled={syncing || !cfg}
                  onClick={() => void useStore.getState().syncNow()}
                >
                  {syncing ? "Synkroniserer …" : "Synkronisér nu"}
                </button>
              </div>
            </div>

            <div className="settings-section">
              <div className="settings-section-title">Tekststørrelse</div>
              <div className="settings-group">
                <div className="settings-row settings-zoom">
                  <button
                    className="settings-zoom-btn"
                    aria-label="Mindre tekst"
                    disabled={zoom <= minZoom()}
                    onClick={() => useStore.getState().setZoom(zoom - 0.1)}
                  >
                    A−
                  </button>
                  <div className="settings-zoom-value">{Math.round(zoom * 100)} %</div>
                  <button
                    className="settings-zoom-btn"
                    aria-label="Større tekst"
                    disabled={zoom >= 1.6}
                    onClick={() => useStore.getState().setZoom(zoom + 0.1)}
                  >
                    A+
                  </button>
                </div>
              </div>
            </div>

            {cfg && (
              <div className="settings-section">
                <div className="settings-section-title">Adgangsnøgle</div>
                <div className="settings-group">
                  <div className="settings-row">
                    <div className="settings-row-main">
                      <div>
                        {keyDays === null
                          ? "Forbundet"
                          : `Forbundet ${daysAgoLabel(keyDays)}`}
                      </div>
                      {(keyExpiring || keyRejected) && (
                        <div className="settings-sub settings-warn-text">
                          {keyRejected
                            ? "GitHub afviser nøglen — lav en ny på GitHub."
                            : keyExpired
                              ? "Nøglen er sikkert udløbet — lav en ny på GitHub."
                              : "Nøglen udløber snart — lav en ny på GitHub."}{" "}
                          <a href={newTokenUrl(cfg.owner)} target="_blank" rel="noopener noreferrer">
                            Opret nøgle
                          </a>
                        </div>
                      )}
                    </div>
                  </div>
                  <button
                    className={"settings-row settings-action" + (keyExpiring || keyRejected ? " strong" : "")}
                    onClick={() => setChangingKey(true)}
                  >
                    Skift adgangsnøgle
                  </button>
                </div>
                <p className="settings-note">
                  Mister du telefonen, så tilbagekald nøglen på{" "}
                  <a href={TOKENS_URL} target="_blank" rel="noopener noreferrer">
                    github.com/settings/personal-access-tokens
                  </a>
                  .
                </p>
              </div>
            )}

            <div className="settings-section">
              <div className="settings-section-title">App</div>
              <div className="settings-group">
                <div className="settings-row">
                  <div className="settings-row-main">
                    <div className="settings-sub settings-sub-plain">{buildLabel()}</div>
                    {update && <div className="settings-sub">{UPDATE_TEXT[update]}</div>}
                  </div>
                </div>
                <button
                  className="settings-row settings-action"
                  disabled={update === "checking" || update === "updating"}
                  onClick={() => void searchUpdate()}
                >
                  Søg efter ny version
                </button>
              </div>
            </div>

            <div className="settings-section">
              <div className="settings-group">
                <button
                  className="settings-row settings-action danger"
                  onClick={() => setConfirmForget(true)}
                >
                  Glem noterne på denne telefon
                </button>
              </div>
              <p className="settings-note">
                Sletter telefonens kopi og nøglen. Noterne på GitHub røres ikke.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
