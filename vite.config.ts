import { execSync } from "node:child_process";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// To udgaver af samme kode: `vite build` er desktop (Tauri læser dist/), og
// `vite build --mode web` er mobilversionen til GitHub Pages (dist-web/).
const WEB_BASE = "/markdown-writer/";

// Pages kan ikke sende headers, så CSP'en kommer som <meta> (kun web)
const CSP = [
  "default-src 'self'",
  "connect-src 'self' https://api.github.com",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
].join("; ");

// kort git-sha, så computer og telefon viser samme version for samme commit
function appVersion(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    const sha = execSync("git rev-parse HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return sha ? sha.slice(0, 7) : "dev";
  } catch {
    return "dev";
  }
}

function webExtras(build: { sha: string; time: string }): Plugin {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`;
  return {
    name: "markdown-writer-web",
    apply: "build",
    transformIndexHtml(html) {
      const charset = /<meta charset="[^"]*"\s*\/?>/i;
      if (!charset.test(html)) {
        throw new Error("index.html mangler <meta charset> — CSP'en kan ikke indsættes");
      }
      return html.replace(charset, (m) => `${m}\n    ${meta}`);
    },
    // appen kan hente version.json (uden om service workeren) og se, om der er en nyere udgave
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: JSON.stringify(build) + "\n",
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const web = mode === "web";
  const build = { sha: appVersion(), time: new Date().toISOString() };

  return {
    base: web ? WEB_BASE : "/",
    define: {
      __APP_VERSION__: JSON.stringify(build.sha),
      __BUILD_TIME__: JSON.stringify(build.time),
    },
    plugins: [
      react(),
      ...(web ? [webExtras(build)] : []),
      // også med i desktop-buildet (slået fra), så `virtual:pwa-register` stadig kan importeres
      VitePWA({
        disable: !web,
        registerType: "prompt",
        injectRegister: false,
        includeAssets: ["icons/*.png"],
        manifest: {
          id: WEB_BASE,
          name: "Markdown Writer",
          short_name: "MD Writer",
          description: "Dine markdown-noter, synket med GitHub.",
          lang: "da",
          start_url: WEB_BASE,
          scope: WEB_BASE,
          display: "standalone",
          theme_color: "#f6f4f1",
          background_color: "#fbfaf8",
          icons: [
            { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
            { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
            {
              src: "icons/maskable-512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            },
          ],
        },
        workbox: {
          globPatterns: ["**/*.{js,css,html,png,svg,webmanifest}"],
          // ikonerne og manifestet lægger pluginnet selv i listen (includeAssets/manifest)
          globIgnores: ["icons/**", "manifest.webmanifest"],
          navigateFallback: "index.html",
          cleanupOutdatedCaches: true,
          maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
          // ingen runtimeCaching: GitHub-kald og HTML må aldrig komme fra en cache
        },
      }),
    ],
    build: {
      outDir: web ? "dist-web" : "dist",
    },
    clearScreen: false,
    server: {
      port: 1420,
      strictPort: true,
    },
  };
});
