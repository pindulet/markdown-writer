// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// .app.mobile er forskudt med transform og dermed "containing block" for
// position: fixed. Opsætningsskærmen inde i appen (Indstillinger → Skift
// adgangsnøgle) må derfor ikke selv forskyde sig med --vvtop en gang til.
beforeAll(() => {
  for (const file of ["../mobile.css", "web.css"]) {
    const style = document.createElement("style");
    style.textContent = readFileSync(resolve(__dirname, file), "utf8");
    document.head.appendChild(style);
  }
  document.documentElement.style.setProperty("--vvtop", "120px");
  document.documentElement.style.setProperty("--vvh", "400px");
});

function setupIn(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.querySelector<HTMLElement>(".setup-screen")!;
}

describe("SetupScreen og den synlige del af skærmen", () => {
  it("inde i .app.mobile fylder den appen, som allerede er placeret efter den synlige del", () => {
    const setup = setupIn(
      '<div class="app mobile"><div class="sidebar"><div class="setup-screen"></div></div></div>'
    );
    const style = getComputedStyle(setup);
    expect(style.position).toBe("fixed");
    expect(style.top).toMatch(/^0(px)?$/);
    expect(style.height).toBe("100%");
  });

  it("uden for appen (første opsætning i WebGate) følger den selv den synlige del", () => {
    const setup = setupIn('<div class="setup-screen"></div>');
    const style = getComputedStyle(setup);
    expect(style.top).toContain("--vvtop");
    expect(style.height).toContain("--vvh");
  });
});
