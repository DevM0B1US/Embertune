import { invoke } from "@tauri-apps/api/core";
import {
  $,
  val,
  setVal,
  esc,
  fmtDur,
  refreshIcons,
  ICON_PLAY,
  ICON_DEL,
  ICON_EDIT,
  ICON_ADD,
  ICON_HEART,
  sndOpen,
  sndClose,
  sndDone,
  confirmDialog,
  tracks,
  setTracks,
  state,
  artCache,
  downloads,
  playlistGroups,
  currentPlaylist,
  favOnly,
  setFavOnly,
  searchTerm,
  setSearchTerm,
  sortBy,
  setSortBy,
  metaTrack,
  setMetaTrack,
} from "./lib";
import { openPlaylistsFor } from "./playlists";
import type { Track } from "./lib";

// --- library ---
export async function refreshLibrary(): Promise<void> {
  if (currentPlaylist) {
    setTracks(await invoke<Track[]>("get_playlist_tracks", { playlistId: currentPlaylist.id }));
  } else {
    setTracks(await invoke<Track[]>("get_library"));
  }
  renderLibrary();
}

function applyViewFilter(list: Track[]): Track[] {
  let out = list;
  if (favOnly) out = out.filter((t) => t.favorite);
  if (searchTerm) {
    const q = searchTerm.toLowerCase();
    out = out.filter((t) =>
      `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q),
    );
  }
  const arr = [...out];
  arr.sort((a, b) => {
    if (sortBy === "title") return a.title.localeCompare(b.title);
    if (sortBy === "artist") return a.artist.localeCompare(b.artist);
    if (sortBy === "duration") return a.duration - b.duration;
    return b.added_at - a.added_at;
  });
  return arr;
}

export function renderLibrary(): void {
  const list = $("#track-list");
  list.innerHTML = "";
  const shown = applyViewFilter(tracks);
  const activeDls =
    [...downloads.values()].length +
    [...playlistGroups.values()].filter((g) => !g.finished).length;
  const empty = $("#empty-library");
  empty.classList.toggle("hidden", shown.length > 0 || activeDls > 0);
  empty.textContent = tracks.length === 0 ? "Nothing here yet. Drop a URL above." : "No matches.";
  $("#btn-back").classList.toggle("hidden", !currentPlaylist);
  $("#btn-playlist-op").classList.toggle("hidden", !currentPlaylist);
  $("#lib-title").textContent = currentPlaylist ? currentPlaylist.name : "Library";

  renderLibraryTracks(list, shown);
}

function renderLibraryTracks(list: HTMLElement, shown: Track[]): void {
  // For big libraries, skip the entrance ripple entirely — 100s of animated
  // rows will jank the scroll even with capped delays.
  const big = shown.length > 120;
  shown.forEach((t, i) => {
    const li = document.createElement("li");
    li.className = "track";
    li.dataset.id = String(t.id);
    li.innerHTML = `
      <button class="play-btn" title="Play">${ICON_PLAY}</button>
      <img class="track-art hidden" alt="" draggable="false" onerror="this.classList.add('hidden'); this.removeAttribute('src');" />
      <div class="track-meta">
        <div class="track-title">${esc(t.title)}</div>
        <div class="track-sub">${esc(t.artist || "—")} · ${fmtDur(t.duration)}</div>
      </div>
      <span class="track-src">${esc(t.source)}</span>
      <div class="row-actions">
        <button class="heart-btn ${t.favorite ? "fav" : ""}" title="Favorite">
          ${ICON_HEART(t.favorite)}
        </button>
        <button class="edit-btn" title="Edit">${ICON_EDIT}</button>
        <button class="addpl-btn" title="Add to playlist">${ICON_ADD}</button>
        <button class="del-btn" title="Delete">${ICON_DEL}</button>
      </div>
    `;
    if (!big) li.style.animationDelay = `${Math.min(i, 14) * 22}ms`;
    li.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".row-actions, .play-btn")) return;
      playTrack(t.id);
    });
    li.querySelector(".heart-btn")!.addEventListener("click", () => toggleFavorite(t));
    li.querySelector(".edit-btn")!.addEventListener("click", () => openMeta(t));
    li.querySelector(".addpl-btn")!.addEventListener("click", (e) => {
      e.stopPropagation();
      openPlaylistsFor(t);
    });
    li.querySelector(".del-btn")!.addEventListener("click", () => deleteTrack(t));
    list.appendChild(li);
    observeRowArt(li, t);
  });
  refreshIcons();
  markPlayingRow();
}

// Row art is fetched from the backend per track — deferring it to an
// IntersectionObserver keeps a thousand-row library from firing a thousand
// FFmpeg/thumbs requests at once; art loads as rows scroll into view.
const pendingArt = new WeakMap<HTMLElement, Track>();
let rowArtObserver: IntersectionObserver | null = null;
function observeRowArt(li: HTMLElement, t: Track): void {
  if (artCache.has(t.id)) {
    setRowArt(li, artCache.get(t.id)!);
    return;
  }
  pendingArt.set(li, t);
  if (!rowArtObserver) {
    rowArtObserver = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          const el = en.target as HTMLElement;
          rowArtObserver!.unobserve(el);
          const track = pendingArt.get(el);
          if (track) {
            pendingArt.delete(el);
            void loadRowArt(track, el);
          }
        }
      },
      { rootMargin: "300px 0px" },
    );
  }
  rowArtObserver.observe(li);
}

// Highlight the library row whose track is currently loaded; animated bars
// when it's actually playing, frozen bars when paused. Toggle is idempotent,
// so the 500ms player poll stays cheap.
export function markPlayingRow(): void {
  const cur = state.current ? String(state.current.id) : null;
  const playing = !!state.playing;
  document.querySelectorAll<HTMLElement>("#track-list .track").forEach((row) => {
    const isCur = cur !== null && row.dataset.id === cur;
    row.classList.toggle("playing", isCur);
    row.classList.toggle("paused", isCur && !playing);
  });
}

async function loadRowArt(t: Track, li: HTMLElement): Promise<void> {
  if (artCache.has(t.id)) {
    setRowArt(li, artCache.get(t.id)!);
    return;
  }
  try {
    const p = await invoke<string | null>("get_art", { trackPath: t.path });
    if (p) {
      artCache.set(t.id, p);
      setRowArt(li, p);
    }
  } catch {
    /* no art */
  }
}

function setRowArt(li: HTMLElement, p: string): void {
  const img = li.querySelector<HTMLImageElement>(".track-art");
  if (!img) return;
  img.src = p;
  img.classList.remove("hidden");
}

async function deleteTrack(t: Track): Promise<void> {
  if (!(await confirmDialog(`Delete "${t.title}" from the library and disk?`, "Delete"))) return;
  await invoke("remove_track", { id: t.id });
  await refreshLibrary();
}

export function playTrack(id: number): void {
  void invoke("play_track", { id });
}

async function toggleFavorite(t: Track): Promise<void> {
  t.favorite = !t.favorite;
  await invoke("set_favorite", { id: t.id, favorite: t.favorite });
  renderLibrary();
}

// --- metadata edit ---
function openMeta(t: Track): void {
  setMetaTrack(t);
  setVal("#meta-title", t.title);
  setVal("#meta-artist", t.artist || "");
  setVal("#meta-album", t.album || "");
  $("#meta-overlay").classList.add("open");
  sndOpen();
  void loadTrackMeta(t);
}

interface TrackMetaInfo {
  format: string;
  codec: string;
  bitrate: number;
  sample_rate: number;
  channels: number;
  duration: number;
  size: number;
}

async function loadTrackMeta(t: Track): Promise<void> {
  const box = $("#meta-details");
  box.innerHTML = "";
  let m: TrackMetaInfo | null;
  try {
    m = await invoke<TrackMetaInfo | null>("get_track_meta", { trackPath: t.path });
  } catch {
    m = null;
  }
  if (!m) {
    box.textContent = "No technical metadata available.";
    return;
  }
  const bits = (b: number): string =>
    b > 0 ? `${(b / 1000).toFixed(0)} kbps` : "—";
  const size = (s: number): string =>
    s > 0 ? `${(s / 1024 / 1024).toFixed(1)} MB` : "—";
  const rows: Array<[string, string]> = [
    ["Format", m.format || "—"],
    ["Codec", m.codec || "—"],
    ["Bitrate", bits(m.bitrate)],
    ["Sample rate", m.sample_rate > 0 ? `${m.sample_rate} Hz` : "—"],
    ["Channels", m.channels > 0 ? String(m.channels) : "—"],
    ["Duration", m.duration > 0 ? fmtDur(m.duration) : "—"],
    ["Size", size(m.size)],
  ];
  box.innerHTML = rows
    .map(([k, v]) => `<div class="meta-row"><span>${k}</span><b>${esc(v)}</b></div>`)
    .join("");
}

$("#meta-cancel").addEventListener("click", () => {
  sndClose();
  $("#meta-overlay").classList.remove("open");
});
$("#meta-overlay").addEventListener("click", (e) => {
  if (e.target === $("#meta-overlay")) {
    sndClose();
    $("#meta-overlay").classList.remove("open");
  }
});
$("#meta-save").addEventListener("click", async () => {
  if (!metaTrack) return;
  await invoke("update_track_meta", {
    id: metaTrack.id,
    title: val("#meta-title").trim() || metaTrack.title,
    artist: val("#meta-artist").trim(),
    album: val("#meta-album").trim(),
  });
  sndDone();
  $("#meta-overlay").classList.remove("open");
  await refreshLibrary();
});

// --- search / sort / favorites ---
let searchDebounce: number | undefined;
$("#search").addEventListener("input", (e) => {
  clearTimeout(searchDebounce);
  searchDebounce = window.setTimeout(() => {
    setSearchTerm((e.target as HTMLInputElement).value.trim());
    renderLibrary();
  }, 120);
});

const SORT_CYCLE: Array<[string, string]> = [
  ["newest", "Newest"],
  ["title", "A–Z"],
  ["artist", "Artist"],
  ["duration", "Dur"],
];
let sortIdx = 0;
function updateSortBtn(): void {
  const b = $("#btn-sort");
  b.dataset.sort = sortBy;
  b.textContent = SORT_CYCLE.find(([k]) => k === sortBy)?.[1] || "Newest";
  b.title = `Sort: ${b.textContent}`;
}
$("#btn-sort").addEventListener("click", () => {
  sortIdx = (sortIdx + 1) % SORT_CYCLE.length;
  setSortBy(SORT_CYCLE[sortIdx][0]);
  updateSortBtn();
  renderLibrary();
});
updateSortBtn();
$("#btn-fav").addEventListener("click", () => {
  setFavOnly(!favOnly);
  $("#btn-fav").classList.toggle("active", favOnly);
  renderLibrary();
});

