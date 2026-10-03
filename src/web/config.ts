import type { GitHubConfig } from "./types";

// Forbindelsen til GitHub gemmes kun i denne browser/på denne telefon.
// Hjemmeskærms-appen på iPhone har sit eget lager, adskilt fra Safari.
const KEY = "mw.web.github";

export const DEFAULT_REPO = "pindulet/notes";
export const DEFAULT_BRANCH = "main";

export function loadConfig(): GitHubConfig | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const cfg = JSON.parse(raw) as GitHubConfig;
    if (!cfg.owner || !cfg.repo || !cfg.branch || !cfg.token) return null;
    return cfg;
  } catch {
    return null;
  }
}

export function saveConfig(cfg: GitHubConfig): void {
  localStorage.setItem(KEY, JSON.stringify(cfg));
}

export function clearConfig(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ikke kritisk
  }
}

// Virtuel rodmappe for noterne, så stier ligner desktop: "/notes/Mappe/Note.md"
export function vaultRoot(cfg: Pick<GitHubConfig, "repo">): string {
  return `/${cfg.repo}`;
}
