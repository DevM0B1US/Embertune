import { invoke } from "@tauri-apps/api/core";
import {
  For,
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import { Heart, Pencil, Play, Trash2 } from "lucide";
import { Ico } from "../lib/icons";
import { fmtDur } from "../lib/format";
import {
  artCache,
  cacheArt,
  confirmDialog,
  consumeReset,
  dlList,
  favOnly,
  invalidateView,
  openMeta,
  playHi,
  playTrack,
  refreshLibrary,
  viewGen,
  viewItems,
} from "../lib/state";
import type { Track } from "../lib/types";

// ── artwork lazy-load ─────────────────────────────────────────────
let artObserver: IntersectionObserver | null = null;
const artMap = new Map<HTMLElement, () => void>();

function getObserver(root: HTMLElement): IntersectionObserver {
  if (artObserver) return artObserver;
  artObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        artObserver!.unobserve(e.target);
        artMap.get(e.target as HTMLElement)?.();
      }
    },
    { root, rootMargin: "400px 0px", threshold: 0 }
  );
  return artObserver;
}

async function loadArt(t: Track, set: (s: string) => void): Promise<void> {
  const c = artCache.get(t.id);
  if (c) { set(c); return; }
  try {
    const p = await invoke<string | null>("get_art", { trackId: t.id });
    if (p) { cacheArt(t.id, p); set(p); }
  } catch {}
}

// ── row actions ───────────────────────────────────────────────────
async function toggleFav(t: Track, set: (v: boolean) => void): Promise<void> {
  const was = t.favorite;
  t.favorite = !was;
  set(!was);
  try { await invoke("set_favorite", { id: t.id, favorite: t.favorite }); }
  catch { t.favorite = was; set(was); return; }
  if (favOnly()) invalidateView(false);
}

async function deleteTrack(t: Track): Promise<void> {
  if (!(await confirmDialog(`Delete "${t.title}" from the library and disk?`, "Delete"))) return;
  await invoke("remove_track", { id: t.id });
  await refreshLibrary();
}

// ── one row ───────────────────────────────────────────────────────
function TrackRow(props: { t: Track; viewEl: HTMLElement }) {
  const t = props.t;
  let li!: HTMLLIElement;
  const [fav, setFav] = createSignal(t.favorite);
  const [art, setArt] = createSignal<string | null>(artCache.get(t.id) ?? null);

  onMount(() => {
    if (!art()) {
      const loader = () => void loadArt(t, setArt);
      artMap.set(li, loader);
      getObserver(props.viewEl).observe(li);
      onCleanup(() => { artMap.delete(li); artObserver?.unobserve(li); });
    }
  });

  return (
    <li
      ref={li}
      class="track"
      data-id={t.id}
      classList={{
        playing: playHi().id === t.id,
        paused: playHi().id === t.id && !playHi().playing,
      }}
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest(".row-actions")) playTrack(t.id);
      }}
    >
      <div class="trow">
        <button
          class="play-btn"
          title="Play"
          aria-label="Play"
          onClick={(e) => { e.stopPropagation(); playTrack(t.id); }}
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
          onError={(e) => { setArt(null); (e.currentTarget as HTMLImageElement).removeAttribute("src"); }}
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
            classList={{ fav: fav() }}
            title="Favorite"
            aria-label="Favorite"
            onClick={(e) => { e.stopPropagation(); void toggleFav(t, setFav); }}
          >
            <Ico node={Heart} size={13} fill={fav() ? "currentColor" : "none"} />
          </button>
          <button
            class="edit-btn"
            title="Edit"
            aria-label="Edit"
            onClick={(e) => { e.stopPropagation(); openMeta(t); }}
          >
            <Ico node={Pencil} size={13} />
          </button>
          <button
            class="del-btn"
            title="Delete"
            aria-label="Delete"
            onClick={(e) => { e.stopPropagation(); void deleteTrack(t); }}
          >
            <Ico node={Trash2} size={14} />
          </button>
        </div>
      </div>
    </li>
  );
}

// ── the list ──────────────────────────────────────────────────────
export default function TrackList(props: { viewEl: HTMLElement }) {
  onMount(() => {
    createEffect(on(viewGen, () => {
      if (consumeReset()) props.viewEl.scrollTop = 0;
    }));
  });

  return (
    <ul id="track-list">
      <For each={viewItems()}>
        {(t) => <TrackRow t={t} viewEl={props.viewEl} />}
      </For>
    </ul>
  );
}
