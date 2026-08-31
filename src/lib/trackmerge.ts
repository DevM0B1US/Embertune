import type { Track } from "./types";

// ═══════════════════════════════════════════════════════════════════
//  Stable-reference track merging (audit P10) — extracted from the
//  library store into a pure module so it is unit-testable (TE1)
//  without pulling WebAudio/window-touched imports into node.
// ═══════════════════════════════════════════════════════════════════

export function sameTrack(a: Track, b: Track): boolean {
  return (
    a.title === b.title &&
    a.artist === b.artist &&
    a.album === b.album &&
    a.duration === b.duration &&
    a.path === b.path &&
    a.source === b.source &&
    a.source_url === b.source_url &&
    a.added_at === b.added_at &&
    a.favorite === b.favorite
  );
}

/** Reuse previous track objects when nothing changed so rows are not
 *  recreated (no flash) on no-op library refreshes. */
export function mergeTracks(prev: Track[], next: Track[]): Track[] {
  if (prev.length === 0) return next;
  const byId = new Map(prev.map((t) => [t.id, t]));
  return next.map((t) => {
    const old = byId.get(t.id);
    return old && sameTrack(old, t) ? old : t;
  });
}
