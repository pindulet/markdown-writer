// Web/mobil: vis opsætningen, indtil telefonen er forbundet med GitHub, og
// hold derefter gem, synk og app-opdateringer i gang. På computeren og i
// mock-udgaven sendes alt bare videre.
import { useEffect, useState, type ReactNode } from "react";
import { platform } from "../backend";
import { useStore } from "../store";
import { loadConfig, vaultRoot } from "./config";
import { requestPersistentStorage, startLifecycle } from "./lifecycle";
import { checkForUpdate, initPwa } from "./pwa";
import SetupScreen from "./SetupScreen";
import type { GitHubConfig } from "./types";
import "./web.css";

// App'ens init læser mappen herfra og starter første synk, så den skal
// være på plads, før App vises
function pinFolder(cfg: GitHubConfig) {
  try {
    const root = vaultRoot(cfg);
    if (localStorage.getItem("mw.folder") !== root) localStorage.setItem("mw.folder", root);
  } catch {
    // uden localStorage er der heller ingen gemt forbindelse
  }
}

function connectedConfig(): GitHubConfig | null {
  const cfg = loadConfig();
  if (cfg) pinFolder(cfg);
  return cfg;
}

function WebShell({ children }: { children: ReactNode }) {
  const [cfg, setCfg] = useState(connectedConfig);

  // også før forbindelsen, så appen virker offline fra første start
  useEffect(() => initPwa(), []);

  useEffect(() => {
    if (!cfg) return;
    requestPersistentStorage();
    return startLifecycle({
      flushAll: () => useStore.getState().flushAll(),
      syncNow: () => useStore.getState().syncNow(),
      lastSyncAt: () => useStore.getState().lastSyncAt,
      checkForUpdate,
    });
  }, [cfg]);

  if (!cfg) {
    return (
      <SetupScreen
        onConnected={(next) => {
          pinFolder(next);
          setCfg(next);
        }}
      />
    );
  }
  return <>{children}</>;
}

export default function WebGate({ children }: { children: ReactNode }) {
  if (platform !== "web") return <>{children}</>;
  return <WebShell>{children}</WebShell>;
}
