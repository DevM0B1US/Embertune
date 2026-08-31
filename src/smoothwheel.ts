// ═══════════════════════════════════════════════════════════════════
//  Smooth wheel scrolling — DISABLED.
//
//  The original implementation intercepted every wheel event,
//  preventDefault'd it, and lerped scrollTop on its own rAF loop
//  (40ms time constant). On WebKitGTK this disabled native compositor
//  scrolling and moved the entire scroll pipeline to the main thread,
//  causing perceptible lag: the lerp trailed the wheel, fast scrolls
//  created/destroyed many virtual rows per frame, and the whole chain
//  (lerp → scrollTop → Solid memo → row mount/unmount → transform
//  writes) happened synchronously in one frame.
//
//  Native WebKitGTK wheel scrolling is notchy but responsive — the
//  compositor handles it off the main thread. The virtualized list
//  already syncs from native scroll events in the same frame (scroll
//  steps fire before rAF callbacks), so there's no one-frame trail.
//
//  This module is kept as a no-op stub so LibraryView's import doesn't
//  break. It can be re-enabled if WebKitGTK's scroll feel improves or
//  if the target platform has a compositor that benefits from smooth
//  wheel interpolation.
// ═══════════════════════════════════════════════════════════════════

export function attachSmoothWheel(_el: HTMLElement): () => void {
  return () => {};
}
