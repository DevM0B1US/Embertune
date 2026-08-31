import { createSignal, onCleanup, onMount } from "solid-js";
import { Heart, Pencil, Play, Trash2 } from "lucide";
import { Ico } from "../lib/icons";
import { fmtDur } from "../lib/format";
import { resolveArt, peekArt, markArtFailed } from "../lib/art";
import { refreshLibrary, setTrackFavorite } from "../lib/state/library";
import { currentId, highlightPlaying, playTrack } from "../lib/state/player";
import { confirmDialog, openMeta } from "../lib/state/ui";
import { invoke } from "@tauri-apps/api/core";
import type { Track } from "../lib/types";

// ═══════════════════════════════════════════════════════════════════
//  TrackRow — one absolutely-positioned row of the virtualized list.
//
//  Rows exist only for the visible window; `absIndex` reacts to window
//  shifts so a row keeps its pixel position (middle rows' absolute
//  index never changes on scroll — their transform writes are no-ops).
//
//  Entrance animation: WAAPI on the inner .trow (never on the
//  positioned wrapper). Two flavors, split by WHEN the row mounts:
//    · cold render (view / search / sort / refresh change): the
//      "one-by-one" cascade — 22ms per row from the window's first row,
//      capped at 320ms. Rows of one cold batch mount in a single
//      synchronous diff pass, so the anchor index is taken from the
//      first row that mounts after markColdRender().
//    · rows entering while scrolling: a SHORT batch-anchored
//      micro-cascade — 14ms per row within the mount batch, hard-capped
//      at 120ms. Every scroll batch re-anchors (rows mounting >60ms
//      apart start a new batch), so delays can never accumulate across
//      a session. Safety: rows mount ~BUFFER×rowH (≈560px) below the
//      viewport, and even a violent 3000px/s fling needs ~190ms to
//      reach them — the ≤120ms hold is always spent off-screen, yet
//      the eye still sees rows appearing one by one.
//    · prefers-reduced-motion: no animation at all.
// ═══════════════════════════════════════════════════════════════════

const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");

// perf markers shared with TrackList (module scope — one list per app)
let coldAt = -1e9;
let coldStartIdx = 0;
let coldPending = false;

const COLD_WINDOW_MS = 400; // rows mounting this soon after a view change are cascade rows
const CASCADE_STEP_MS = 22; // per-row cascade delay
const CASCADE_CAP_MS = 320; // never stagger longer than this

// scroll-in micro-cascade (batch-anchored — see header comment)
let lastRowMountAt = -1e9;
let scrollAnchorIdx = 0;
const SCROLL_BATCH_GAP_MS = 60; // a quiet gap this long starts a new batch
const SCROLL_STEP_MS = 14; // per-row delay inside a scroll batch
const SCROLL_CAP_MS = 120; // hard cap — holds are always spent off-screen

/** Called by TrackList when the visible id sequence changes (viewKey). */
export function markColdRender(): void {
  coldAt = performance.now();
  coldPending = true; // first row of the batch anchors the cascade origin
}

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

// ── artwork: one shared IntersectionObserver, preloads 600px ahead ──
//
// Art transport (real app): the `art://` custom URI protocol — the
// webview fetches the JPEG itself (async, off the main thread, HTTP-
// cached) instead of dragging a base64 string over IPC and decoding it
// on the main thread. That IPC+decode burst was the lag-spike source
// on real libraries; with the protocol it disappears entirely.
// Scheduling policy (shared by both transports):
//   · rows INSIDE the viewport load immediately, even mid-gesture —
//     a blank cover flashing in after the fling is worse than a
//     browser-scheduled load (which no longer touches the main thread)
//   · rows in the 600px prefetch ring wait out the gesture; ~150ms
//     after the last scroll event the queue flushes in small chunks
//   · cached URLs (artCache) are synchronous and unaffected
let artObserver: IntersectionObserver | null = null;
const artLoaders = new Map<HTMLElement, () => void>();
const artQueue = new Map<HTMLElement, () => void>();
let scrollBusyUntil = 0;
let artFlushTimer: number | undefined;

const ART_FLUSH_CHUNK = 6;
const ART_CHUNK_GAP_MS = 50;

export function notifyScrollActivity(): void {
  scrollBusyUntil = performance.now() + 150;
  scheduleArtFlush();
}

function scheduleArtFlush(): void {
  if (artFlushTimer !== undefined) return;
  artFlushTimer = window.setTimeout(
    flushArtQueue,
    Math.max(0, scrollBusyUntil - performance.now()) + 20
  );
}

function flushArtQueue(): void {
  artFlushTimer = undefined;
  if (performance.now() < scrollBusyUntil) {
    scheduleArtFlush();
    return;
  }
  if (artQueue.size === 0) return;
  let done = 0;
  for (const [el, loader] of artQueue) {
    artQueue.delete(el);
    loader();
    if (++done >= ART_FLUSH_CHUNK) break;
  }
  if (artQueue.size > 0) {
    artFlushTimer = window.setTimeout(flushArtQueue, ART_CHUNK_GAP_MS);
  }
}

function ensureObserver(root: HTMLElement): IntersectionObserver {
  if (artObserver) return artObserver;
  artObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        artObserver!.unobserve(e.target);
        const el = e.target as HTMLElement;
        const loader = artLoaders.get(el);
        if (!loader) continue;
        // non-empty intersectionRect = actually inside the viewport
        // (rootMargin extends isIntersecting to the prefetch ring too)
        const inViewport = e.intersectionRect.width > 0 && e.intersectionRect.height > 0;
        if (inViewport || performance.now() >= scrollBusyUntil) loader();
        else artQueue.set(el, loader);
      }
    },
    { root, rootMargin: "600px 0px", threshold: 0 }
  );
  return artObserver;
}

function loadRowArt(t: Track, setArt: (s: string | null) => void): void {
  void resolveArt(t.id).then((url) => {
    if (url) setArt(url);
  });
}

async function deleteTrack(t: Track): Promise<void> {
  if (!(await confirmDialog(`Delete "${t.title}" from the library and disk?`, "Delete"))) return;
  await invoke("remove_track", { id: t.id });
  await refreshLibrary();
}

export default function TrackRow(props: {
  track: Track;
  index: () => number;
  start: () => number;
  rowH: () => number;
  viewEl: HTMLElement;
}) {
  // track reference is fixed per row instance (<For> maps by identity)
  const t = props.track;
  const absIndex = () => props.start() + props.index();

  let li!: HTMLLIElement;
  const [art, setArt] = createSignal<string | null>(peekArt(t.id));

  onMount(() => {
    // entrance animation — cold cascade (view change) vs scroll-in
    // micro-cascade. Scroll batches re-anchor on every quiet gap, so
    // delays stay within [0, SCROLL_CAP_MS] forever.
    const trow = li.firstElementChild as HTMLElement | null;
    if (trow && !REDUCED_MOTION.matches) {
      const now = performance.now();
      if (now - coldAt < COLD_WINDOW_MS) {
        if (coldPending) {
          coldStartIdx = absIndex();
          coldPending = false;
        }
        animateCascade(trow, (absIndex() - coldStartIdx) * CASCADE_STEP_MS);
      } else {
        if (now - lastRowMountAt > SCROLL_BATCH_GAP_MS) scrollAnchorIdx = absIndex();
        lastRowMountAt = now;
        animateScrollIn(trow, (absIndex() - scrollAnchorIdx) * SCROLL_STEP_MS);
      }
    }

    // artwork — lazy via shared observer unless already cached. Rows
    // inside the viewport load immediately (browser-scheduled fetch,
    // off the main thread); the 600px prefetch ring waits out gestures.
    if (!art()) {
      const loader = () => loadRowArt(t, setArt);
      artLoaders.set(li, loader);
      ensureObserver(props.viewEl).observe(li);
      onCleanup(() => {
        artLoaders.delete(li);
        artQueue.delete(li);
        artObserver?.unobserve(li);
      });
    }
  });

  return (
    <li
      ref={li}
      class="track"
      data-id={t.id}
      classList={{
        playing: currentId() === t.id,
        paused: currentId() === t.id && !highlightPlaying(),
      }}
      style={{ transform: `translate3d(0, ${absIndex() * props.rowH()}px, 0)` }}
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest(".row-actions")) playTrack(t.id);
      }}
    >
      <div class="trow">
        <button
          class="play-btn"
          title="Play"
          aria-label="Play"
          onClick={(e) => {
            e.stopPropagation();
            playTrack(t.id);
          }}
        >
          <Ico node={Play} size={13} cls="row-play-icon" />
        </button>
        <img
          class="track-art"
          classList={{ hidden: !art() }}
          src={art() ?? undefined}
          alt=""
          draggable={false}
          loading="lazy"
          decoding="async"
          onError={(e) => {
            markArtFailed(t.id);
            setArt(null);
            (e.currentTarget as HTMLImageElement).removeAttribute("src");
          }}
        />
        <div class="track-meta">
          <div class="track-title" title={t.artist ? `${t.title} — ${t.artist}` : t.title}>
            {t.title}
          </div>
          <div class="track-sub">
            {t.artist || "—"} · {fmtDur(t.duration)}
          </div>
        </div>
        <span class="track-src">{t.source}</span>
        <div class="row-actions">
          <button
            class="heart-btn"
            classList={{ fav: t.favorite }}
            title="Favorite"
            aria-label="Favorite"
            onClick={(e) => {
              e.stopPropagation();
              void setTrackFavorite(t);
            }}
          >
            <Ico node={Heart} size={13} fill={t.favorite ? "currentColor" : "none"} />
          </button>
          <button
            class="edit-btn"
            title="Edit"
            aria-label="Edit"
            onClick={(e) => {
              e.stopPropagation();
              openMeta(t);
            }}
          >
            <Ico node={Pencil} size={13} />
          </button>
          <button
            class="del-btn"
            title="Delete"
            aria-label="Delete"
            onClick={(e) => {
              e.stopPropagation();
              void deleteTrack(t);
            }}
          >
            <Ico node={Trash2} size={14} />
          </button>
        </div>
      </div>
    </li>
  );
}
