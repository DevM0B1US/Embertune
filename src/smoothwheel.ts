// ═══════════════════════════════════════════════════════════════════
//  Smooth wheel scrolling for WebKitGTK.
//
//  On Linux the system webview scrolls in discrete, notchy wheel steps
//  with no inertia — fine for documents, terrible for a music library.
//  This intercepts wheel events over the scroll container and lerps
//  scrollTop toward a target on its own rAF loop: buttery, inertial,
//  and frame-rate independent (exponential smoothing with a ~40ms
//  time constant — tight enough that the list tracks the wheel with
//  no perceived lag, soft enough to melt the notchy steps).
//
//  After each animated scrollTop write it fires emitScrollFrame() so
//  scroll-position consumers (the virtualized list window) update in
//  the SAME frame — scroll events alone would deliver the change one
//  frame late and the list would visibly trail the wheel.
//
//  Deliberately stays out of the way of:
//  · the scrollbar (dragging it hands control back instantly)
//  · keyboard / find-in-page scrolling (scroll events resync the target)
//  · pinch-zoom (ctrl+wheel) and horizontal wheel
//  · nested scrollers (e.g. the downloads panel scrolls natively)
//  · prefers-reduced-motion (module becomes a no-op)
// ═══════════════════════════════════════════════════════════════════

import { emitScrollFrame } from "./lib/scrollsync";

// exponential smoothing time constant (ms). Lower = snappier. 68ms read
// as a soft glide but users described the list as "laggy" — every notch
// took ~200ms to fully land. 40ms keeps the glide, halves the lag.
const TIME_CONSTANT_MS = 40;

export function attachSmoothWheel(el: HTMLElement): () => void {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (reduce.matches) return () => {};

  let target = el.scrollTop;
  let raf = 0;
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
    // snap: below ~1px the exponential tail is invisible but keeps the
    // rAF loop (and row updates) alive — land exactly on target and stop.
    // Next wheel event re-kicks from the snapped position (target resync
    // reads el.scrollTop, which now equals the old target), so nothing
    // is lost by ending the loop here.
    if (Math.abs(diff) < 1) {
      if (cur !== target) {
        el.scrollTop = target;
        lastSet = target;
        emitScrollFrame();
      }
      return; // settled
    }

    const k = 1 - Math.exp(-dt / TIME_CONSTANT_MS);
    const next = cur + diff * k;
    el.scrollTop = next;
    lastSet = next;
    // same-frame notification: scroll events for this write only fire
    // NEXT frame (scroll steps run before rAF callbacks), so consumers
    // that rely on them trail the animation by exactly one frame
    emitScrollFrame();
    raf = requestAnimationFrame(step);
  };

  const kick = (): void => {
    if (!raf) {
      lastT = performance.now();
      raf = requestAnimationFrame(step);
    }
  };

  const onWheel = (e: WheelEvent): void => {
    // pinch-zoom and horizontal-only scrolls stay native
    if (e.ctrlKey || e.deltaY === 0) return;
    // nested scrollers inside the view keep native behavior
    const t = e.target as HTMLElement | null;
    if (t?.closest?.("#downloads-panel")) return;

    e.preventDefault();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= el.clientHeight;
    dy *= 1.2; // gain — notchy wheels travel a natural distance

    if (raf === 0) target = el.scrollTop; // resync after external scroll
    const max = maxScroll();
    target = Math.min(max, Math.max(0, target + dy));
    kick();
  };
  el.addEventListener("wheel", onWheel, { passive: false });

  // no animation running → any scroll came from outside (scrollbar,
  // keyboard, programmatic) — keep the target glued to reality
  const onScroll = (): void => {
    if (raf === 0) target = el.scrollTop;
  };
  el.addEventListener("scroll", onScroll, { passive: true });

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
    // full teardown (audit B7): the wheel/scroll handlers used to survive
    // the cleanup, relying on GC to collect the whole closure cycle
    el.removeEventListener("wheel", onWheel);
    el.removeEventListener("scroll", onScroll);
    document.removeEventListener("visibilitychange", onVisChange);
    reduce.removeEventListener?.("change", mqListener);
  };
}
