import { invoke } from "@tauri-apps/api/core";
import { createSignal, onCleanup, onMount } from "solid-js";
import { Heart, Pencil, Play, Trash2 } from "lucide";
import { Ico } from "../lib/icons";
import { fmtDur } from "../lib/format";
import { artCache, cacheArt, refreshLibrary, setTrackFavorite } from "../lib/state/library";
import { currentId, highlightPlaying, playTrack } from "../lib/state/player";
import { confirmDialog, openMeta } from "../lib/state/ui";
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
//    · rows entering while scrolling: an 80ms pure-opacity fade with
//      ZERO delay. A zero-delay fade physically cannot read as "late"
//      — the row is fully opaque one frame after mount. No stagger, no
//      counters, no velocity heuristics (a cumulative batch counter
//      grows unbounded across a scroll session and was the cause of
//      rows visibly lagging behind their neighbours mid-fling).
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

function animateFadeIn(el: HTMLElement): void {
  el.animate([{ opacity: "0" }, { opacity: "1" }], {
    duration: 80,
    easing: "linear",
    fill: "backwards",
  });
}

// ── artwork: one shared IntersectionObserver, preloads 600px ahead ──
//
// Load scheduling matters for scroll smoothness: each get_art round
// trip ends in a main-thread image decode, and a burst of those during
// a scroll gesture reads as lag spikes (the virtualized list itself is
// cheap — this was the remaining jank source on real libraries).
// Therefore:
//   · while the list is actively scrolling (notifyScrollActivity),
//     entering rows' loads are queued, not started
//   · ~150ms after the last scroll event the queue flushes in small
//     chunks, spreading decodes over a few frames
//   · cached art (artCache) is synchronous and unaffected
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
        if (performance.now() < scrollBusyUntil) artQueue.set(el, loader);
        else loader();
      }
    },
    { root, rootMargin: "600px 0px", threshold: 0 }
  );
  return artObserver;
}

async function loadArt(t: Track, setArt: (s: string) => void): Promise<void> {
  const cached = artCache.get(t.id);
  if (cached) {
    setArt(cached);
    return;
  }
  try {
    const p = await invoke<string | null>("get_art", { trackId: t.id });
    if (p) {
      cacheArt(t.id, p);
      setArt(p);
    }
  } catch {
    /* no art */
  }
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
  const [art, setArt] = createSignal<string | null>(artCache.get(t.id) ?? null);

  onMount(() => {
    // entrance animation — cold cascade (view change) vs instant fade
    // (scroll-in). Delays are only ever assigned on cold renders; rows
    // entering the window through scrolling appear immediately.
    const trow = li.firstElementChild as HTMLElement | null;
    if (trow && !REDUCED_MOTION.matches) {
      if (performance.now() - coldAt < COLD_WINDOW_MS) {
        if (coldPending) {
          coldStartIdx = absIndex();
          coldPending = false;
        }
        animateCascade(trow, (absIndex() - coldStartIdx) * CASCADE_STEP_MS);
      } else {
        animateFadeIn(trow);
      }
    }

    // artwork — lazy via shared observer unless already cached; loads
    // are deferred while scrolling (see notifyScrollActivity above)
    if (!art()) {
      const loader = () => void loadArt(t, setArt);
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
