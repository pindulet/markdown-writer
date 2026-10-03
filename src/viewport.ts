// iOS lægger tastaturet oven på siden uden at gøre layoutet mindre, og der
// findes ingen CSS for tastaturets højde. Derfor følger appen visualViewport:
// --vvh er den synlige højde, --vvtop hvor langt iOS har forskudt den synlige
// del, og <html> får klassen kb-open, mens tastaturet er oppe. Mobil-CSS'en
// (.app.mobile) bruger variablerne; på desktop bruges de ikke.

const KEYBOARD_MIN_PX = 80;

export function initViewport(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  let raf = 0;
  let settle = 0;
  let lastHeight = "";
  let lastTop = "";
  let keyboardOpen = false;

  const apply = () => {
    raf = 0;
    // knibezoom ændrer også visualViewport; dér skal appen ikke krympe
    if (vv.scale > 1.01) return;
    const height = `${Math.round(vv.height)}px`;
    const top = `${Math.round(Math.max(0, vv.offsetTop))}px`;
    if (height !== lastHeight) root.style.setProperty("--vvh", (lastHeight = height));
    if (top !== lastTop) root.style.setProperty("--vvtop", (lastTop = top));
    const full = Math.max(root.clientHeight, window.innerHeight);
    const open = full - vv.height > KEYBOARD_MIN_PX;
    if (open !== keyboardOpen) {
      keyboardOpen = open;
      root.classList.toggle("kb-open", open);
      // editorerne kan lytte og rulle markøren til syne igen
      window.dispatchEvent(new CustomEvent("mw-keyboard", { detail: open }));
    }
  };

  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(apply);
    // iOS 26 melder ikke altid den endelige størrelse, når tastaturet lukker
    window.clearTimeout(settle);
    settle = window.setTimeout(apply, 350);
  };

  vv.addEventListener("resize", schedule);
  vv.addEventListener("scroll", schedule);
  window.addEventListener("orientationchange", schedule);

  // iOS kan efterlade vinduet forskudt, når tastaturet lukker; siden selv
  // skal aldrig rulle (det gør editorerne og listen inde i appen)
  document.addEventListener("focusout", () => {
    window.setTimeout(() => {
      const active = document.activeElement;
      const editable = active?.closest(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"])'
      );
      if (!editable && (window.scrollY !== 0 || window.scrollX !== 0)) {
        window.scrollTo(0, 0);
      }
      schedule();
    }, 100);
  });

  apply();
}
