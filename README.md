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

## Udvikling

Kræver Node og Rust (`rustup`).

```bash
npm install
npm run tauri dev     # kør i udviklingstilstand
npm run tauri build   # byg .app (ligger i src-tauri/target/release/bundle/macos)
```

## Arkitektur

- **Frontend**: React + TypeScript (Vite). CodeMirror 6 til markdown-visningen,
  TipTap til layout-visningen. Tilstand i `src/store.ts` (zustand).
- **Backend**: Tauri 2 (Rust) i `src-tauri/src/main.rs` — fillæsning/-skrivning
  (atomisk), mappeliste, omdøb, slet (til papirkurv) og filovervågning
  (`notify`), som sender `fs-change`-events til frontenden.
- **Princip**: disken er sandheden. Appen ejer ingen data — alt er .md-filer i
  den valgte mappe. Layout-visningen skriver kun markdown tilbage, når du
  faktisk redigerer i den.
