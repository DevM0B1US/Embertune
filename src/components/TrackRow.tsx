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
import { useRowFx } from "./rowfx";

// ═══════════════════════════════════════════════════════════════════
//  TrackRow — one absolutely-positioned row of the virtualized list.
//
//  Rows exist only for the visible window; `absIndex` reacts to window
//  shifts so a row keeps its pixel position (middle rows' absolute
//  index never changes on scroll — their transform writes are no-ops).
//
//  Deliberately NO entrance animation: rows mount already visible —
//  the list is bare and instant by design (user request). Artwork is
//  lazy via the shared observer, with rows inside the viewport loading
//  immediately (fetch is browser-scheduled, off the main thread).
//
//  provided by LibraryView (context) — NOT in module scope (audit Q2:
//  one list per app was a fragile, undocumented assumption; audit B4:
//  a module-cached observer kept a stale detached root alive after
//  ErrorBoundary recovery).
// ═══════════════════════════════════════════════════════════════════

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
  selected: () => boolean;
}) {
  // track reference is fixed per row instance (<For> maps by identity)
  const t = props.track;
  const absIndex = () => props.start() + props.index();
  const fx = useRowFx();

  let li!: HTMLLIElement;
  const [art, setArt] = createSignal<string | null>(peekArt(t.id));
  const [hovered, setHovered] = createSignal(false);

  onMount(() => {
    // artwork — lazy via shared observer unless already cached. Rows
    // inside the viewport load immediately (browser-scheduled fetch,
    // off the main thread); the 600px prefetch ring waits out gestures.
    if (!art()) {
      fx.observeArt(li, props.viewEl, () => {
        void resolveArt(t.id).then((url) => {
          if (url) setArt(url);
        });
      });
      onCleanup(() => fx.unobserveArt(li));
    }
  });

  return (
    <li
      ref={li}
      id={`track-row-${t.id}`}
      class="track"
      data-id={t.id}
      role="option"
      aria-selected={props.selected()}
      classList={{
        playing: currentId() === t.id,
        paused: currentId() === t.id && !highlightPlaying(),
        selected: props.selected(),
      }}
      style={{ transform: `translate3d(0, ${absIndex() * props.rowH()}px, 0)` }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
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
          {hovered() && (
            <>
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
            </>
          )}
        </div>
      </div>
    </li>
  );
}
