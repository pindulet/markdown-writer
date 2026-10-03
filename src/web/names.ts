// Navne fra brugeren → fil- og mappenavne, der også virker på computeren
// (macOS) og i git. Unikhed afgøres uden hensyn til store/små bogstaver og
// Unicode-form (NFC/NFD), ligesom macOS' filsystem gør — ellers kunne
// telefonen lave to filer, computeren ikke kan holde adskilt.
export const UNTITLED = "Uden titel";

const FORBIDDEN = /[/\\:*?"<>|]/g;
const CONTROL = /[\u0000-\u001f\u007f]/g;
// plads til " 99" og ".md" under macOS' grænse på 255 bytes pr. navn
const MAX_BYTES = 200;

const encoder = new TextEncoder();

function clip(name: string): string {
  if (encoder.encode(name).length <= MAX_BYTES) return name;
  let out = "";
  let bytes = 0;
  for (const ch of name) {
    // NFD fylder mest (computeren kan gemme navnet sådan)
    const n = encoder.encode(ch.normalize("NFD")).length;
    if (bytes + n > MAX_BYTES) break;
    out += ch;
    bytes += n;
  }
  return out;
}

// Mappenavn (og grundlaget for notenavne): ulovlige tegn bliver til "-",
// ingen punktum foran (skjulte filer), intet mellemrum/punktum til sidst.
export function cleanName(raw: string): string {
  let name = raw.normalize("NFC").replace(CONTROL, " ").replace(FORBIDDEN, "-").trim();
  name = name.replace(/^[.\s]+/, "");
  name = clip(name).replace(/[\s.]+$/, "");
  return name || UNTITLED;
}

// Notenavn uden .md (skriver man "Note.md", bliver filen ikke "Note.md.md")
export function cleanNoteName(raw: string): string {
  return cleanName(raw.trim().replace(/\.md$/i, ""));
}

// "Navn", "Navn 2", "Navn 3" … som desktop
export function uniqueName(name: string, isTaken: (candidate: string) => boolean): string {
  if (!isTaken(name)) return name;
  for (let i = 2; ; i++) {
    const candidate = `${name} ${i}`;
    if (!isTaken(candidate)) return candidate;
  }
}
