// ═══════════════════════════════════════════════════════════════════
//  Smooth wheel scrolling for WebKitGTK.
//
//  On Linux the system webview scrolls in discrete, notchy wheel steps
//  with no inertia — fine for documents, terrible for a music library.
//  This intercepts wheel events over the scroll container and lerps
//  scrollTop toward a target on its own rAF loop: buttery, inertial,
//  and frame-rate independent (exponential smoothing with a ~68ms
//  time constant — soft enough to read as glide, tight enough that
//  the list never feels detached from the wheel).
//
//  Deliberately stays out of the way of:
//  · the scrollbar (dragging it hands control back instantly)
//  · keyboard / find-in-page scrolling (scroll events resync the target)
//  · pinch-zoom (ctrl+wheel) and horizontal wheel
//  · nested scrollers (e.g. the downloads panel scrolls natively)
//  · prefers-reduced-motion (module becomes a no-op)
// ═══════════════════════════════════════════════════════════════════

export function attachSmoothWheel(el: HTMLElement): () => void {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (reduce.matches) return () => {};

  let target = el.scrollTop;
  let raf = 0;
  let lastWheelAt = 0;
  let lastSet = el.scrollTop;
  let lastT = 0;

  const maxScroll = (): number =>
    Math.max(0, el.scrollHeight - el.clientHeight);

  const stop = (): void => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };

  const step = (now: number): void => {
    raf = 0;
    const dt = Math.min(64, (now - lastT || 16.7));
    lastT = now;

    // content may have shrunk (filter change, deletions) — re-clamp
    const max = maxScroll();
    if (target > max) target = max;
    if (target < 0) target = 0;

    const cur = el.scrollTop;
    // external scroll while animating (user grabbed the scrollbar,
    // keyboard jump) — hand control back instead of fighting it
    if (Math.abs(cur - lastSet) > 1.5) {
      target = cur;
      lastSet = cur;
      return;
    }

    const diff = target - cur;
    if (Math.abs(diff) < 0.5 && now - lastWheelAt > 120) {
      lastSet = cur;
      return; // settled
    }

    const k = 1 - Math.exp(-dt / 68); // ~0.22 per 60fps frame — soft glide
    const next = cur + diff * k;
    el.scrollTop = next;
    lastSet = next;
    raf = requestAnimationFrame(step);
  };

  const kick = (): void => {
    if (!raf) {
      lastT = performance.now();
      raf = requestAnimationFrame(step);
    }
  };

  el.addEventListener(
    "wheel",
    (e: WheelEvent) => {
      // pinch-zoom and horizontal-only scrolls stay native
      if (e.ctrlKey || e.deltaY === 0) return;
      // nested scrollers inside the view keep native behavior
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("#downloads-panel")) return;

      e.preventDefault();
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16;
      else if (e.deltaMode === 2) dy *= el.clientHeight;
      dy *= 1.15; // gentle gain — notchy wheels travel a natural distance

      if (raf === 0) target = el.scrollTop; // resync after external scroll
      const max = maxScroll();
      target = Math.min(max, Math.max(0, target + dy));
      lastWheelAt = performance.now();
      kick();
    },
    { passive: false }
  );

  // no animation running → any scroll came from outside (scrollbar,
  // keyboard, programmatic) — keep the target glued to reality
  el.addEventListener(
    "scroll",
    () => {
      if (raf === 0) target = el.scrollTop;
    },
    { passive: true }
  );

  const onVisChange = (): void => {
    if (document.hidden) {
      stop();
      target = el.scrollTop;
      lastSet = target;
    }
  };
  document.addEventListener("visibilitychange", onVisChange);

  // if reduced-motion gets enabled mid-session, detach
  const mqListener = (): void => {
    if (reduce.matches) {
      stop();
      reduce.removeEventListener?.("change", mqListener);
    }
  };
  reduce.addEventListener?.("change", mqListener);

  return () => {
    stop();
    document.removeEventListener("visibilitychange", onVisChange);
    reduce.removeEventListener?.("change", mqListener);
  };
}
