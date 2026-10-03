// Git-blob-SHA-1 og base64 af tekst, præcis som git og GitHub regner dem:
// over tekstens UTF-8-bytes uden nogen normalisering (BOM og CRLF bevares).

const encoder = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

// sha1("blob <antal bytes>\0<bytes>") — samme som `git hash-object`
export async function gitBlobSha(text: string): Promise<string> {
  const body = encoder.encode(text);
  const head = encoder.encode(`blob ${body.length}\0`);
  const buf = new Uint8Array(head.length + body.length);
  buf.set(head);
  buf.set(body, head.length);
  return toHex(await crypto.subtle.digest("SHA-1", buf));
}

// RFC 4648-base64 med korrekt padding (createCommitOnBranch afviser alt andet)
export function utf8ToBase64(text: string): string {
  const bytes = encoder.encode(text);
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (typeof native === "function") return native.call(bytes);
  // btoa tager en "binær" streng; i bidder, så store noter ikke sprænger argumentgrænsen
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
