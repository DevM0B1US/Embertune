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
//  Entrance animation: WAAPI fade+slide on the inner .trow (never on
//  the positioned wrapper). Two flavors:
//    · cold render (search / sort / refresh with new content):
//      "one-by-one" cascade, 22ms/row capped at 320ms
//    · rows entering while scrolling: quick 150ms micro-stagger,
//      skipped during fast flings (>4px/ms) and reduced motion
// ═══════════════════════════════════════════════════════════════════

const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");

// perf markers shared with TrackList (module scope — one list per app)
let coldAt = -1e9;
let coldStartIdx = 0;
let batchN = 0;
let lastVel = 0;

export function markColdRender(startIdx: number): void {
  coldAt = performance.now();
  coldStartIdx = startIdx;
  batchN = 0;
}

export function notifyScrollVelocity(vel: number): void {
  lastVel = vel;
}

function animateIn(el: HTMLElement, delay: number, quick: boolean): void {
  el.animate(
    [
      { opacity: "0", transform: "translateY(7px)" },
      { opacity: "1", transform: "translateY(0)" },
    ],
    {
      duration: quick ? 150 : 280,
      delay: Math.max(0, delay),
      easing: quick ? "ease-out" : "cubic-bezier(0.22, 1, 0.36, 1)",
      fill: "backwards",
    }
  );
}

// ── artwork: one shared IntersectionObserver, preloads 600px ahead ──
let artObserver: IntersectionObserver | null = null;
const artLoaders = new Map<HTMLElement, () => void>();

function ensureObserver(root: HTMLElement): IntersectionObserver {
  if (artObserver) return artObserver;
  artObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        artObserver!.unobserve(e.target);
        artLoaders.get(e.target as HTMLElement)?.();
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
    // entrance animation — cold cascade vs scroll-in micro-stagger
    const trow = li.firstElementChild as HTMLElement | null;
    if (trow && !REDUCED_MOTION.matches) {
      if (performance.now() - coldAt < 400) {
        animateIn(trow, (absIndex() - coldStartIdx) * 22, false);
      } else if (lastVel < 4) {
        animateIn(trow, batchN++ * 12, true);
      }
    }

    // artwork — lazy via shared observer unless already cached
    if (!art()) {
      const loader = () => void loadArt(t, setArt);
      artLoaders.set(li, loader);
      ensureObserver(props.viewEl).observe(li);
      onCleanup(() => {
        artLoaders.delete(li);
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
