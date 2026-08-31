import { resolveAsset, saveImage } from "./backend";
import { useStore } from "./store";

// Relativ billedsti i markdown → URL webviewet kan vise.
// "./x.png" er relativ til notens egen mappe; "Billeder/x.png" til vaultens rod.
export function resolveImageSrc(src: string): string {
  if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src)) return src; // http, https, data, asset …
  if (src.startsWith("/")) return resolveAsset(src);
  const { folder, activePath } = useStore.getState();
  if (!folder) return src;
  if (src.startsWith("./")) {
    const dir = activePath ? activePath.slice(0, activePath.lastIndexOf("/")) : folder;
    return resolveAsset(`${dir}/${src.slice(2)}`);
  }
  return resolveAsset(`${folder}/${src}`);
}

// Gemmer et indsat billede i vaultens "Billeder"-mappe og returnerer den
// relative sti til brug i markdown.
export async function saveClipboardImage(file: File): Promise<string | null> {
  const folder = useStore.getState().folder;
  if (!folder) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  const dataBase64 = btoa(binary);
  const ext = (file.type.split("/")[1] || "png")
    .replace("jpeg", "jpg")
    .replace("svg+xml", "svg");
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  const name = `indsat-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(
    d.getDate()
  )}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${ext}`;
  const absPath = await saveImage(`${folder}/Billeder`, name, dataBase64);
  const fileName = absPath.split("/").pop() ?? name;
  return `Billeder/${fileName}`;
}
