// ── cover-art resolution (single shared path for list rows + player) ──
//
// Inside Tauri: `art://<id>` custom URI protocol — the webview fetches
// the JPEG itself (async request, off-main-thread decode, HTTP-cached
// by the webview). No base64-over-IPC, no main-thread decode burst:
// that was the scroll lag on real libraries.
//
// In the browser dev harness: falls back to the mocked `get_art`
// command so `?tracks=N` sessions still show covers.
//
// Failures (art file missing → 404) are remembered per session so a
// row remount never re-requests a known-missing cover.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { artCache, cacheArt } from "./state/library";

const IS_TAURI = "__TAURI_INTERNALS__" in window;
const artFailed = new Set<number>();

/** Resolve display art for a track id. Never throws; returns null when
 *  the track is known to have no cover. */
export async function resolveArt(id: number): Promise<string | null> {
  const cached = artCache.get(id);
  if (cached) return cached;
  if (artFailed.has(id)) return null;
  if (IS_TAURI) {
    // deterministic URL keyed by track id — resolved to a file path
    // server-side (inside the protocol handler), HTTP-cached after
    const url = convertFileSrc(String(id), "art");
    cacheArt(id, url);
    return url;
  }
  try {
    const p = await invoke<string | null>("get_art", { trackId: id });
    if (p) {
      cacheArt(id, p);
      return p;
    }
  } catch {
    /* mocked/unavailable */
  }
  return null;
}

/** Synchronous cache peek — lets a row mount with its art already set
 *  (no load flash on remounts). */
export function peekArt(id: number): string | null {
  return artCache.get(id) ?? null;
}

/** img onError hook — remember the miss and evict the dead entry. */
export function markArtFailed(id: number): void {
  artFailed.add(id);
  artCache.delete(id);
}
