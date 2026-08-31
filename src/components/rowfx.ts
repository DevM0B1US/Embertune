// ═══════════════════════════════════════════════════════════════════
//  RowFx — per-library-list effects: entrance cascade state, scroll-in
//  ripple, and the shared artwork IntersectionObserver + prefetch
//  queue. Created once by LibraryView and consumed through context
//  (audit Q2/B4).
//
//  WHY a context instead of module scope: the old module singletons
//  assumed exactly one list per app forever, and the IntersectionObserver
//  cached against the FIRST view element — after an ErrorBoundary reset
//  (or any future remount), new rows observed against a stale detached
//  root and covers silently stopped loading (audit B4). The instance now
//  lives and dies with LibraryView: `dispose()` disconnects the
//  observer, drops queued loaders and cancels timers.
//
//  The tuning constants and state transitions are behaviorally identical
//  to the module-scope version they replace — see TrackRow's header for
//  the cascade/ripple design notes.
// ═══════════════════════════════════════════════════════════════════

import { createContext, useContext } from "solid-js";

const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");

// ── cold-render cascade (view / search / sort change) ──────────────
const COLD_WINDOW_MS = 400; // rows mounting this soon after a view change are cascade rows
const CASCADE_STEP_MS = 22; // per-row cascade delay
const CASCADE_CAP_MS = 320; // never stagger longer than this

// ── scroll-in ripple (per-gesture) ─────────────────────────────────
const GESTURE_END_MS = 350; // quiet gap this long ends the gesture
const SCROLL_STEP_MS = 16; // per-row delay step inside a gesture
const SCROLL_CAP_MS = 120; // hard cap — holds are always spent off-screen

// ── artwork scheduling ─────────────────────────────────────────────
const ART_FLUSH_CHUNK = 6;
const ART_CHUNK_GAP_MS = 50;

export interface RowFx {
  /** Called by TrackList when the visible id sequence changes (viewKey). */
  markColdRender(): void;
  /** Called by TrackList on every (rAF-coalesced) scroll event. */
  notifyScrollActivity(): void;
  /** Run the entrance animation for a row that just mounted. */
  runEntrance(trow: HTMLElement, absIndex: number): void;
  /** Start lazy-loading a row's cover via the shared observer. */
  observeArt(li: HTMLElement, viewEl: HTMLElement, loader: () => void): void;
  /** Stop observing a row that is unmounting. */
  unobserveArt(li: HTMLElement): void;
  /** Detach everything — LibraryView is going away. */
  dispose(): void;
}

export function createRowFx(): RowFx {
  // cold cascade
  let coldAt = -1e9;
  let coldStartIdx = 0;
  let coldPending = false;

  // scroll-in ripple
  let lastRowMountAt = -1e9;
  let rippleDelay = 0;

  // artwork
  let observer: IntersectionObserver | null = null;
  let observerRoot: HTMLElement | null = null;
  const loaders = new Map<HTMLElement, () => void>();
  const queue = new Map<HTMLElement, () => void>();
  let scrollBusyUntil = 0;
  let flushTimer: number | undefined;

  function animateCascade(el: HTMLElement, delay: number): void {
    el.animate(
      [
        { opacity: "0", transform: "translateY(7px)" },
        { opacity: "1", transform: "translateY(0)" },
      ],
      {
        duration: 280,
        delay: Math.min(Math.max(0, delay), CASCADE_CAP_MS),
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        fill: "backwards",
      }
    );
  }

  function animateScrollIn(el: HTMLElement, delay: number): void {
    el.animate(
      [
        { opacity: "0", transform: "translateY(4px)" },
        { opacity: "1", transform: "translateY(0)" },
      ],
      {
        duration: 170,
        delay: Math.min(Math.max(0, delay), SCROLL_CAP_MS),
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        fill: "backwards",
      }
    );
  }

  function scheduleFlush(): void {
    if (flushTimer !== undefined) return;
    flushTimer = window.setTimeout(
      flush,
      Math.max(0, scrollBusyUntil - performance.now()) + 20
    );
  }

  function flush(): void {
    flushTimer = undefined;
    if (performance.now() < scrollBusyUntil) {
      scheduleFlush();
      return;
    }
    if (queue.size === 0) return;
    let done = 0;
    for (const [el, loader] of queue) {
      queue.delete(el);
      loader();
      if (++done >= ART_FLUSH_CHUNK) break;
    }
    if (queue.size > 0) {
      flushTimer = window.setTimeout(flush, ART_CHUNK_GAP_MS);
    }
  }

  function ensureObserver(root: HTMLElement): IntersectionObserver {
    if (observer && observerRoot === root) return observer;
    // root changed (fresh LibraryView element) — rebuild against it
    observer?.disconnect();
    observerRoot = root;
    observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          observer!.unobserve(e.target);
          const el = e.target as HTMLElement;
          const loader = loaders.get(el);
          if (!loader) continue;
          // non-empty intersectionRect = actually inside the viewport
          // (rootMargin extends isIntersecting to the prefetch ring too)
          const inViewport = e.intersectionRect.width > 0 && e.intersectionRect.height > 0;
          if (inViewport || performance.now() >= scrollBusyUntil) loader();
          else queue.set(el, loader);
        }
      },
      { root, rootMargin: "600px 0px", threshold: 0 }
    );
    return observer;
  }

  return {
    markColdRender(): void {
      coldAt = performance.now();
      coldPending = true; // first row of the batch anchors the cascade origin
    },

    notifyScrollActivity(): void {
      scrollBusyUntil = performance.now() + 150;
      scheduleFlush();
    },

    runEntrance(trow: HTMLElement, absIndex: number): void {
      if (REDUCED_MOTION.matches) return;
      const now = performance.now();
      if (now - coldAt < COLD_WINDOW_MS) {
        if (coldPending) {
          coldStartIdx = absIndex;
          coldPending = false;
        }
        animateCascade(trow, (absIndex - coldStartIdx) * CASCADE_STEP_MS);
      } else {
        rippleDelay =
          now - lastRowMountAt > GESTURE_END_MS
            ? SCROLL_STEP_MS
            : Math.min(rippleDelay + SCROLL_STEP_MS, SCROLL_CAP_MS);
        lastRowMountAt = now;
        animateScrollIn(trow, rippleDelay);
      }
    },

    observeArt(li: HTMLElement, viewEl: HTMLElement, loader: () => void): void {
      loaders.set(li, loader);
      ensureObserver(viewEl).observe(li);
    },

    unobserveArt(li: HTMLElement): void {
      loaders.delete(li);
      queue.delete(li);
      observer?.unobserve(li);
    },

    dispose(): void {
      if (flushTimer !== undefined) {
        window.clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      observer?.disconnect();
      observer = null;
      observerRoot = null;
      loaders.clear();
      queue.clear();
    },
  };
}

// ── context plumbing ─────────────────────────────────────────────────
const RowFxContext = createContext<RowFx>();

/** Provided by LibraryView around the list subtree. */
export const RowFxProvider = RowFxContext.Provider;

export function useRowFx(): RowFx {
  const fx = useContext(RowFxContext);
  if (!fx) throw new Error("RowFx used outside <RowFxProvider>");
  return fx;
}
