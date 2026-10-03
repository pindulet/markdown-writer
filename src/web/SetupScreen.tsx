// Web/mobil: forbind appen med noterne på GitHub. Bruges også til at skifte
// adgangsnøgle (initial sat) — så ligger repo og branch fast, fordi telefonens
// lokale kopi hører til dét repo.
import { useState, type FormEvent } from "react";
import { verifyConnection } from "./github";
import { DEFAULT_BRANCH, DEFAULT_REPO, saveConfig, vaultRoot } from "./config";
import { requestPersistentStorage } from "./lifecycle";
import { GitHubError, type GitHubConfig } from "./types";

// iPhone/iPad i Safari (ikke hjemmeskærms-appen). iPadOS udgiver sig for at være en Mac.
function inSafariOnIos(): boolean {
  const ua = navigator.userAgent;
  const ios =
    /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const standalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches;
  return ios && !standalone;
}

// "pindulet/notes", også indsat som github.com-adresse eller med .git
function parseRepo(input: string): { owner: string; repo: string } | null {
  const s = input
    .trim()
    .replace(/^(https?:\/\/)?(www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const m = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)$/.exec(s);
  return m ? { owner: m[1], repo: m[2] } : null;
}

// GitHubs side til en ny fine-grained nøgle, udfyldt så langt GitHub tillader
// (repoet kan ikke forvælges)
export function newTokenUrl(owner: string): string {
  return (
    "https://github.com/settings/personal-access-tokens/new" +
    "?name=Markdown+Writer+iPhone&description=Noter+p%C3%A5+telefonen" +
    `&target_name=${encodeURIComponent(owner)}&expires_in=366&contents=write`
  );
}

export function errorText(e: unknown, repo: string, token: string): string {
  if (e instanceof GitHubError) {
    if (e.kind === "auth") return "GitHub afviste nøglen — tjek at du har kopieret hele nøglen.";
    if (e.kind === "not-found") {
      // repoet findes, men branchen ikke (verifyConnection siger hvilken)
      if (e.message.startsWith("Branchen ")) return `${e.message}.`;
      return `Repoet blev ikke fundet — har nøglen adgang til ${repo}?`;
    }
    if (e.kind === "offline") return "Ingen forbindelse til GitHub.";
  }
  if (e instanceof TypeError) return "Ingen forbindelse til GitHub.";
  const msg = e instanceof Error ? e.message : String(e);
  // nøglen må aldrig stå på skærmen
  return token ? msg.split(token).join("…") : msg;
}

export default function SetupScreen({
  onConnected,
  initial,
  onCancel,
}: {
  onConnected: (cfg: GitHubConfig) => void;
  initial?: Partial<GitHubConfig>;
  onCancel?: () => void;
}) {
  const changingKey = !!(initial?.owner && initial?.repo);
  const [repoText, setRepoText] = useState(
    changingKey ? `${initial?.owner}/${initial?.repo}` : DEFAULT_REPO
  );
  const [branch, setBranch] = useState(initial?.branch || DEFAULT_BRANCH);
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installHint, setInstallHint] = useState(() => !changingKey && inSafariOnIos());

  const parsed = parseRepo(repoText);
  const owner = parsed?.owner ?? DEFAULT_REPO.split("/")[0];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const target = parseRepo(repoText);
    if (!target) {
      setError(`Skriv repoet som ejer/navn, fx ${DEFAULT_REPO}.`);
      return;
    }
    const key = token.trim();
    if (!key) {
      setError("Indsæt adgangsnøglen fra GitHub.");
      return;
    }
    const cfg: GitHubConfig = {
      owner: target.owner,
      repo: target.repo,
      branch: branch.trim() || DEFAULT_BRANCH,
      token: key,
      connectedAt: Date.now(),
    };
    setBusy(true);
    setError(null);
    try {
      await verifyConnection(cfg);
    } catch (err) {
      setError(errorText(err, `${cfg.owner}/${cfg.repo}`, key));
      setBusy(false);
      return;
    }
    try {
      saveConfig(cfg);
    } catch {
      setError("Nøglen kunne ikke gemmes på telefonen. Er privat browsing slået til?");
      setBusy(false);
      return;
    }
    requestPersistentStorage();
    try {
      localStorage.setItem("mw.folder", vaultRoot(cfg));
    } catch {
      // WebGate sætter den også
    }
    onConnected(cfg);
  };

  if (installHint) {
    return (
      <div className="setup-screen">
        <div className="setup-inner">
          <h1 className="setup-title">Markdown Writer</h1>
          <div className="setup-card setup-card-accent">
            <div className="setup-card-title">Læg appen på hjemmeskærmen først</div>
            <p className="setup-text">
              Tryk på <strong>Del</strong> → <strong>Føj til hjemmeskærm</strong>. Åbn den
              derfra og indsæt nøglen dér — hjemmeskærms-appen har sit eget lager.
            </p>
            <p className="setup-text setup-text-muted">
              Hvis iPhonen spørger, så lad den åbne som webapp. Ellers kan Safari rydde
              telefonens kopi af noterne efter en uges tid.
            </p>
          </div>
          <button
            type="button"
            className="setup-btn setup-btn-secondary"
            onClick={() => setInstallHint(false)}
          >
            Fortsæt i Safari alligevel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="setup-screen">
      <form className="setup-inner" onSubmit={(e) => void submit(e)} noValidate>
        <h1 className="setup-title">{changingKey ? "Ny adgangsnøgle" : "Markdown Writer"}</h1>
        <p className="setup-lead">
          {changingKey
            ? `Indsæt en ny nøgle til ${repoText}. Noterne på telefonen bliver, hvor de er.`
            : "Forbind med dine noter på GitHub. Nøglen gemmes kun på denne telefon."}
        </p>

        {changingKey ? (
          <div className="setup-field">
            <span className="setup-label">Repo</span>
            <div className="setup-static">
              {repoText} · {branch}
            </div>
            <span className="setup-hint">
              Vil du skifte repo, skal du først glemme noterne på denne telefon under
              Indstillinger.
            </span>
          </div>
        ) : (
          <>
            <label className="setup-field">
              <span className="setup-label">Repo</span>
              <input
                className="setup-input"
                value={repoText}
                placeholder="ejer/navn"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => setRepoText(e.target.value)}
              />
            </label>
            <details className="setup-advanced">
              <summary>Avanceret</summary>
              <label className="setup-field">
                <span className="setup-label">Branch</span>
                <input
                  className="setup-input"
                  value={branch}
                  placeholder={DEFAULT_BRANCH}
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(e) => setBranch(e.target.value)}
                />
              </label>
            </details>
          </>
        )}

        <div className="setup-card">
          <a
            className="setup-link"
            href={newTokenUrl(owner)}
            target="_blank"
            rel="noopener noreferrer"
          >
            Opret en nøgle på GitHub
          </a>
          <ol className="setup-steps">
            <li>Log ind på GitHub, hvis du bliver bedt om det.</li>
            <li>
              Under <em>Repository access</em> vælger du <em>Only select repositories</em> og
              kun <strong>{parsed?.repo ?? "notes"}</strong>.
            </li>
            <li>
              Tjek at <em>Contents</em> står til <em>Read and write</em>.
            </li>
            <li>
              Tryk <em>Generate token</em>, kopiér nøglen, og indsæt den herunder.
            </li>
          </ol>
          <p className="setup-hint">Nøglen gælder i et år.</p>
        </div>

        <div className="setup-field">
          <label className="setup-label" htmlFor="setup-token">
            Adgangsnøgle
          </label>
          <div className="setup-token">
            <input
              id="setup-token"
              className="setup-input"
              type={showToken ? "text" : "password"}
              value={token}
              placeholder="github_pat_…"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => setToken(e.target.value)}
            />
            <button
              type="button"
              className="setup-reveal"
              onClick={() => setShowToken(!showToken)}
            >
              {showToken ? "Skjul" : "Vis"}
            </button>
          </div>
        </div>

        {error && (
          <div className="setup-error" role="alert">
            {error}
          </div>
        )}

        <button type="submit" className="setup-btn" disabled={busy}>
          {busy ? "Forbinder …" : changingKey ? "Gem nøgle" : "Forbind"}
        </button>
        {onCancel && (
          <button
            type="button"
            className="setup-btn setup-btn-secondary"
            disabled={busy}
            onClick={onCancel}
          >
            Annuller
          </button>
        )}
      </form>
    </div>
  );
}
