# Markdown Writer — regler for arbejdet i koden

Appen findes i to udgaver, bygget fra **samme kode**:

- **Desktop**: Tauri-appen på Mac. Noterne ligger som filer i vaulten, og synk sker med system-git.
- **Mobil**: web-app (PWA) på iPhonens hjemmeskærm, udrullet til
  `https://pindulet.github.io/markdown-writer/`. Noterne ligger i IndexedDB på telefonen og
  synkes med det private repo `pindulet/notes` via GitHubs API (`src/web/`).

Hver ændring skal virke i begge udgaver.

## Platformgrænsen

- Al adgang til filer, git og OS går gennem `src/backend.ts` (`Backend`-interfacet).
  `platform` er `"desktop" | "web" | "mock"`.
- Importér aldrig `@tauri-apps/*` uden for `backend.ts`.
- Mobil-layout styres af bredden (`useIsMobile()`, under 700 px), ikke af platformen.
  Platformforskelle i komponenter skal være små og gå via `platform`.
- Mobil har ingen ⌘-genveje, Tab, højreklik eller hover. Nye funktioner skal derfor også kunne nås
  med tryk: `FormatToolbar` (`src/editorCommands.ts`), topbarens ⋯-menu eller langt tryk i notelisten.
- Brugervendt tekst er på dansk. Inputs og redigerbar tekst på mobil skal være mindst 16 px,
  ellers zoomer iOS ind.

## Data må aldrig gå tabt

- Disken er sandheden. På telefonen er IndexedDB "disken", og `src/web/syncEngine.ts` svarer til git.
- Telefonens ventende ændringer (beskidte `FileRecord`s) må aldrig smides væk ved en opdatering.
  Ændres formatet, skal `v` hæves og gamle poster migreres.
- Layout-visningen skriver kun de blokke tilbage, man har ændret (`src/markdownPreserve.ts`).
  Alt, der påvirker parsing eller serialisering, skal ligge i `schemaExtensions()`
  (`src/components/layoutExtensions.ts`), så den skjulte serializer altid er identisk med editoren.
- Desktopens `git_sync` løser selv konflikter: union-merge for `.md` og en "(konflikt)"-kopi for
  andet. Lokale commits, der ikke er pushet, lægges sammen før rebasen. `git_sync` rører aldrig
  en rebase eller merge, den ikke selv har startet, og efterlader aldrig repoet midt i en rebase.

## Før du committer

```bash
npm test             # vitest; vault-testen kører kun på Kristians Mac
npm run build        # desktop-frontend (tsc + vite)
npm run build:web    # mobilversionen
```

Rust: `cd src-tauri && cargo test`. Test UI-ændringer i browseren både ved fuld bredde og ved ca.
390 px (`npm run dev` bruger mock-backenden; `window.claudeWrite(path, content)` simulerer
eksterne ændringer).

## Udgiv

Commit og kør derefter `npm run release`. Scriptet:

1. tester;
2. bygger begge udgaver;
3. erstatter `/Applications/Markdown Writer.app`;
4. pusher til main.

Pushet udruller mobilversionen via `.github/workflows/pages.yml`, og telefonen henter den selv,
næste gang appen åbnes. Begge udgaver viser samme version (kort git-sha): i `?`-dialogen på desktop
og under Indstillinger på mobil.
