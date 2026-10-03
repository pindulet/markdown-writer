# Markdown Writer

En simpel macOS-editor til markdown-noter, bygget til at arbejde sammen med
Claude: når Claude opdaterer en fil på disken, vises ændringen med det samme i
appen.

## Funktioner

- Pinned mappe i venstre kolonne (huskes mellem sessioner)
- Flere filer åbne i faner
- To visninger med switcher (⌘E): **Markdown** (kildetekst) og **Layout** (formateret)
- **Autosave** — der gemmes automatisk ca. 1 sekund efter du holder pause
- **Live-opdatering**: ændrer Claude (eller andre) en fil på disken, opdateres
  den lydløst i appen; har du selv ugemte ændringer, får du et valg
- Prik-indikator på faner og filer, der er ændret udefra, samt "Fortryd"
- Formatering via markering + højreklik eller ⌘B / ⌘I / ⌘K
- macOS' indbyggede stavekontrol (højreklik på et ord uden markering)
- Fokustilstand: ⌘\ skjuler sidebaren · Ny note: ⌘N
- Atomiske skrivninger — Claude læser aldrig en halvgemt fil
- Billeder: indsæt med paste (gemmes i vaultens `Billeder`-mappe), vises i layout view
- Obsidian-wikilinks: `[[Note]]` og `[[Note|alias]]` — ⌘-klik åbner (eller opretter) noten
- Faktabokse: `> [!fakta] Titel` vises som farvet boks (også `info`, `tip`, `advarsel` m.fl.)
- Lys og mørk tilstand følger systemet

## Genveje

| Genvej | Handling |
| --- | --- |
| ⌘E | Skift mellem markdown- og layout-visning |
| ⌘\ | Vis/skjul sidebar (fokustilstand) |
| ⌘N | Ny note |
| ⌘B / ⌘I | Fed / kursiv |
| ⌘K | Indsæt link |
| ⌘1 – ⌘6 | Overskrift 1–6 |
| ⌘0 | Brødtekst (fjern overskrift) |
| Tab / ⇧Tab | Ryk ind / ryk ud (lister) |
| ⌘-klik på link | Åbn link i browser |

## Mobilversion (iPhone)

Samme app findes som web-app til telefonen på
**https://pindulet.github.io/markdown-writer/**. Den læser og skriver noterne direkte i
GitHub-repoet `pindulet/notes` og har en lokal kopi, så den også virker uden net.

**Sådan kommer den på telefonen (én gang):**

1. Åbn adressen i Safari på iPhonen → Del → **Føj til hjemmeskærm**.
2. Åbn appen fra hjemmeskærmen. Den har sit eget lager, adskilt fra Safari.
3. Tryk **Opret en nøgle på GitHub** og godkend: kun adgang til `notes`, Contents: Read and write.
4. Kopiér nøglen, indsæt den i appen og tryk **Forbind**. Første gang hentes alle noter (få sekunder).

Noter åbnes i læsetilstand. **Rediger** giver tastatur og en formateringslinje (fed, kursiv,
overskrift, lister, ryk ind/ud, link). Ændringer gemmes med det samme på telefonen og sendes til
GitHub efter et øjeblik, når appen lukkes, eller næste gang der er net. Computeren henter dem ved næste
synk. Ændrer begge sider samme note, flettes versionerne, så intet går tabt. Langt tryk på en note
giver Omdøb og Slet. Under ⚙ finder du synkstatus, tekststørrelse, version og nøglen.
Billeder findes kun på computeren, fordi de holdes ude af git.

Mister du telefonen, så tilbagekald nøglen på github.com/settings/personal-access-tokens.

## Udvikling

Kræver Node og Rust (`rustup`).

```bash
npm install
npm run tauri dev     # kør i udviklingstilstand
npm run tauri build   # byg .app (ligger i src-tauri/target/release/bundle/macos)
npm run dev           # UI i browseren med simulerede noter (også til mobilbredde)
npm test              # tests (synk-motor, bevaring af markdown, editor-kommandoer)
```

## Udgiv en ændring (computer og telefon på én gang)

Commit ændringen og kør:

```bash
npm run release
```

Scriptet tester og bygger begge udgaver, erstatter appen i `/Applications` og pusher til GitHub.
GitHub Actions udruller derefter mobilversionen, og telefonen opdaterer sig selv, næste gang appen
åbnes. Begge viser samme versionsnummer: `?`-dialogen på computeren, ⚙ på telefonen.

## Arkitektur

- **Frontend**: React + TypeScript (Vite). CodeMirror 6 til markdown-visningen,
  TipTap til layout-visningen. Tilstand i `src/store.ts` (zustand).
- **Backend**: Tauri 2 (Rust) i `src-tauri/src/main.rs` — fillæsning/-skrivning
  (atomisk), mappeliste, omdøb, slet (til papirkurv) og filovervågning
  (`notify`), som sender `fs-change`-events til frontenden.
- **Mobil/web**: samme React-kode bygget med `vite build --mode web`. `src/web/` indeholder
  GitHub-backenden (IndexedDB-kopi + synk via GitHubs REST/GraphQL-API), opsætning og
  service worker. Mobil-layoutet (noteliste, topbar, formateringslinje over tastaturet) slår til
  under 700 px.
- **Princip**: disken er sandheden. Appen ejer ingen data — alt er .md-filer i
  den valgte mappe. Layout-visningen skriver kun markdown tilbage, når du
  faktisk redigerer i den.
