// ═══════════════════════════════════════════════════════════════════
//  Frame-synchronous scroll notifications.
//
//  WHY THIS EXISTS (scroll "feel" lag):
//  smoothwheel advances scrollTop inside a requestAnimationFrame
//  callback. Per the HTML rendering-update order, scroll events fire
//  in the "scroll steps" — which run BEFORE that frame's rAF
//  callbacks — so a scrollTop written during rAF N produces a scroll
//  event in frame N+1. Any consumer updating off the scroll event
//  (e.g. the virtualized list window) therefore renders exactly one
//  frame behind the animated scroll, every animated frame: rows trail
//  the scroll position and the list reads as "laggy" even though the
//  frame rate is fine.
//
//  emitScrollFrame() lets smoothwheel notify consumers in the SAME
//  task that moved scrollTop, so DOM updates land in the same frame.
//  Subscribers must be idempotent (compare last-seen scrollTop and
//  bail when unchanged) — the scroll event path still exists as the
//  fallback for native scrolling (scrollbar drag, keyboard, touch).
// ═══════════════════════════════════════════════════════════════════

type ScrollFrameSink = () => void;

const sinks = new Set<ScrollFrameSink>();

/** Subscribe a same-frame scroll update callback; returns unsubscribe. */
export function onScrollFrame(fn: ScrollFrameSink): () => void {
  sinks.add(fn);
  return () => {
    sinks.delete(fn);
  };
}

/** Fire all subscribers — call in the same task that changed scrollTop. */
export function emitScrollFrame(): void {
  for (const fn of sinks) fn();
}
