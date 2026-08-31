// ═══════════════════════════════════════════════════════════════════
//  RowFx — per-library-list effects: the shared artwork
//  IntersectionObserver + prefetch queue, and scroll-busy gating that
//  keeps cover fetches from piling up mid-gesture. Created once by
//  LibraryView and consumed through context (audit Q2/B4).
//
//  WHY a context instead of module scope: the old module singletons
//  assumed exactly one list per app forever, and the IntersectionObserver
//  cached against the FIRST view element — after an ErrorBoundary reset
//  (or any future remount), new rows observed against a stale detached
//  root and covers silently stopped loading (audit B4). The instance now
//  lives and dies with LibraryView: `dispose()` disconnects the
//  observer, drops queued loaders and cancels timers.
//
//  Entrance animations (cold cascade / scroll ripple) were REMOVED by
//  design — the list is deliberately bare and instant: rows mount
//  already visible, no WAAPI work per row, no stagger bookkeeping.
// ═══════════════════════════════════════════════════════════════════

import { createContext, useContext } from "solid-js";

// ── artwork scheduling ─────────────────────────────────────────────
const ART_FLUSH_CHUNK = 6;
const ART_CHUNK_GAP_MS = 50;

export interface RowFx {
  /** Called by TrackList on every (rAF-coalesced) scroll event. */
  notifyScrollActivity(): void;
  /** Start lazy-loading a row's cover via the shared observer. */
  observeArt(li: HTMLElement, viewEl: HTMLElement, loader: () => void): void;
  /** Stop observing a row that is unmounting. */
  unobserveArt(li: HTMLElement): void;
  /** Detach everything — LibraryView is going away. */
  dispose(): void;
}

export function createRowFx(): RowFx {
  // artwork
  let observer: IntersectionObserver | null = null;
  let observerRoot: HTMLElement | null = null;
  const loaders = new Map<HTMLElement, () => void>();
  const queue = new Map<HTMLElement, () => void>();
  let scrollBusyUntil = 0;
  let flushTimer: number | undefined;

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
    notifyScrollActivity(): void {
      scrollBusyUntil = performance.now() + 150;
      scheduleFlush();
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
