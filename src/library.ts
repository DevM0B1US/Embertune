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
  favOnly,
  setFavOnly,
  searchTerm,
  setSearchTerm,
  sortBy,
  setSortBy,
  metaTrack,
  setMetaTrack,
} from "./lib";
import type { Track } from "./lib";

// --- library (virtualization OFF — full render, zero scroll blank) ---
let shownTracks: Track[] = [];
let virtualScrollHandlerAttached = false;
let lastRefreshIcons = 0;
function viewEl(): HTMLElement {
  return (document.getElementById("view-library") as HTMLElement) || (document.querySelector(".view") as HTMLElement);
}
function listEl(): HTMLElement {
  return document.getElementById("track-list") as HTMLElement;
}

function scheduleVirtualRender(): void {
  // no-op — full render always, no scroll windowing
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

export async function refreshLibrary(): Promise<void> {
  setTracks(await invoke<Track[]>("get_library"));
  renderLibrary();
}

export function renderLibrary(): void {
  shownTracks = applyViewFilter(tracks);
  const activeDls = downloads.size;
  const empty = document.getElementById("empty-library") as HTMLElement;
  empty.classList.toggle("hidden", shownTracks.length > 0 || activeDls > 0);
  empty.textContent = tracks.length === 0 ? "Nothing here yet. Drop a URL above." : "No matches.";

  if (!virtualScrollHandlerAttached) {
    virtualScrollHandlerAttached = true;
    const list = listEl();
    list.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const row = target.closest<HTMLElement>(".track");
      if (!row || !row.dataset.id) return;
      const id = Number(row.dataset.id);
      const t = shownTracks.find((x) => x.id === id) || tracks.find((x) => x.id === id);
      if (!t) return;
      if (target.closest(".heart-btn")) {
        e.stopPropagation();
        void toggleFavorite(t);
        return;
      }
      if (target.closest(".edit-btn")) {
        e.stopPropagation();
        openMeta(t);
        return;
      }
      if (target.closest(".del-btn")) {
        e.stopPropagation();
        void deleteTrack(t);
        return;
      }
      if (target.closest(".play-btn")) {
        e.stopPropagation();
        playTrack(id);
        return;
      }
      if (!target.closest(".row-actions, .play-btn")) playTrack(id);
    });
  }
  renderVirtualWindow();
}

function renderVirtualWindow(): void {
  const list = listEl();
  const total = shownTracks.length;
  if (total === 0) {
    list.innerHTML = "";
    list.style.paddingTop = "0px";
    list.style.paddingBottom = "0px";
    return;
  }
  // FULL render — no windowing, no blank. Research showed windowing blank = worse than full render cost
  // Keep fast path: DocumentFragment + single refreshIcons, delegate handles events
  list.style.paddingTop = "0px";
  list.style.paddingBottom = "0px";
  const frag = document.createDocumentFragment();
  const curId = state.current ? String(state.current.id) : null;
  const playing = !!state.playing;
  for (let i = 0; i < total; i++) {
    const t = shownTracks[i];
    const li = document.createElement("li");
    li.className = "track";
    if (curId !== null && String(t.id) === curId) {
      li.classList.add("playing");
      if (!playing) li.classList.add("paused");
    }
    li.dataset.id = String(t.id);
    if (i < 14) li.style.animationDelay = `${i * 10}ms`;
    li.innerHTML = `
      <button class="play-btn" title="Play">${ICON_PLAY}</button>
      <img class="track-art hidden" alt="" draggable="false" loading="lazy" />
      <div class="track-meta">
        <div class="track-title">${esc(t.title)}</div>
        <div class="track-sub">${esc(t.artist || "—")} · ${fmtDur(t.duration)}</div>
      </div>
      <span class="track-src">${esc(t.source)}</span>
      <div class="row-actions">
        <button class="heart-btn ${t.favorite ? "fav" : ""}" title="Favorite">${ICON_HEART(t.favorite)}</button>
        <button class="edit-btn" title="Edit">${ICON_EDIT}</button>
        <button class="del-btn" title="Delete">${ICON_DEL}</button>
      </div>`;
    frag.appendChild(li);
    observeAppear(li, i);
    observeRowArt(li, t);
  }
  list.replaceChildren(frag);
  if (performance.now() - lastRefreshIcons > 120) {
    lastRefreshIcons = performance.now();
    requestAnimationFrame(() => refreshIcons());
  }
}

// one-time appear — hide roughness, never re-trigger
let appearObserver: IntersectionObserver | null = null;
function observeAppear(li: HTMLElement, idx: number): void {
  // stagger first 12 for nicer entrance
  if (idx < 12) li.style.transitionDelay = `${idx * 18}ms`;
  if (!appearObserver) {
    appearObserver = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const el = e.target as HTMLElement;
          el.classList.add("in");
          appearObserver!.unobserve(el);
        }
      },
      { root: viewEl(), rootMargin: "60px 0px", threshold: 0.06 },
    );
  }
  appearObserver.observe(li);
}

// Row art — same IntersectionObserver but now only for visible window
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
      { root: viewEl(), rootMargin: "400px 0px", threshold: 0 },
    );
  }
  rowArtObserver.observe(li);
}

// Optimized markPlayingRow — only scans visible virtual rows (max ~40) not full N
export function markPlayingRow(): void {
  const cur = state.current ? String(state.current.id) : null;
  const playing = !!state.playing;
  const rows = listEl().querySelectorAll<HTMLElement>(".track");
  // fast path: if total large, query is cheap (only visible)
  rows.forEach((row) => {
    const isCur = cur !== null && row.dataset.id === cur;
    // avoid toggle if already correct
    const hasPlaying = row.classList.contains("playing");
    if (isCur !== hasPlaying) row.classList.toggle("playing", isCur);
    const hasPaused = row.classList.contains("paused");
    const shouldPaused = isCur && !playing;
    if (shouldPaused !== hasPaused) row.classList.toggle("paused", shouldPaused);
  });
}

async function loadRowArt(t: Track, li: HTMLElement): Promise<void> {
  if (artCache.has(t.id)) {
    // element may be recycled — check still attached and same track
    if (li.isConnected && li.dataset.id === String(t.id)) setRowArt(li, artCache.get(t.id)!);
    return;
  }
  try {
    const p = await invoke<string | null>("get_art", { trackId: t.id });
    if (p) {
      // LRU cap — keep cache under 120 entries to avoid base64 bloat
      if (artCache.size >= 120) {
        const firstKey = artCache.keys().next().value;
        if (firstKey !== undefined) artCache.delete(firstKey as number);
      }
      artCache.set(t.id, p);
      if (li.isConnected && li.dataset.id === String(t.id)) setRowArt(li, p);
    }
  } catch {
    /* no art */
  }
}

function setRowArt(li: HTMLElement, p: string): void {
  const img = li.querySelector<HTMLImageElement>(".track-art");
  if (!img) return;
  // avoid adding multiple error listeners on reused nodes
  if (img.dataset.bound !== "1") {
    img.dataset.bound = "1";
    img.addEventListener("error", () => {
      img.classList.add("hidden");
      img.removeAttribute("src");
    });
  }
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
  // cheap re-sort without full fetch: just re-render virtual
  renderLibrary();
}

// --- metadata edit ---
function openMeta(t: Track): void {
  setMetaTrack(t);
  setVal("#meta-title", t.title);
  setVal("#meta-artist", t.artist || "");
  setVal("#meta-album", t.album || "");
  ($("#meta-overlay") as HTMLElement).classList.add("open");
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
  const box = document.getElementById("meta-details") as HTMLElement;
  box.innerHTML = "";
  let m: TrackMetaInfo | null;
  try {
    m = await invoke<TrackMetaInfo | null>("get_track_meta", { trackId: t.id });
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
  // single write
  box.innerHTML = rows
    .map(([k, v]) => `<div class="meta-row"><span>${k}</span><b>${esc(v)}</b></div>`)
    .join("");
}

(document.getElementById("meta-cancel") as HTMLElement).addEventListener("click", () => {
  sndClose();
  (document.getElementById("meta-overlay") as HTMLElement).classList.remove("open");
});
(document.getElementById("meta-overlay") as HTMLElement).addEventListener("click", (e) => {
  if (e.target === document.getElementById("meta-overlay")) {
    sndClose();
    (document.getElementById("meta-overlay") as HTMLElement).classList.remove("open");
  }
});
(document.getElementById("meta-save") as HTMLElement).addEventListener("click", async () => {
  if (!metaTrack) return;
  await invoke("update_track_meta", {
    id: metaTrack.id,
    title: val("#meta-title").trim() || metaTrack.title,
    artist: val("#meta-artist").trim(),
    album: val("#meta-album").trim(),
  });
  sndDone();
  (document.getElementById("meta-overlay") as HTMLElement).classList.remove("open");
  await refreshLibrary();
});

// --- search / sort / favorites ---
let searchDebounce: number | undefined;
(document.getElementById("search") as HTMLInputElement).addEventListener("input", (e) => {
  clearTimeout(searchDebounce);
  searchDebounce = window.setTimeout(() => {
    setSearchTerm((e.target as HTMLInputElement).value.trim());
    renderLibrary();
  }, 150);
});

const SORT_CYCLE: Array<[string, string]> = [
  ["newest", "Newest"],
  ["title", "A–Z"],
  ["artist", "Artist"],
  ["duration", "Dur"],
];
let sortIdx = 0;
function updateSortBtn(): void {
  const b = document.getElementById("btn-sort") as HTMLElement;
  b.dataset.sort = sortBy;
  b.textContent = SORT_CYCLE.find(([k]) => k === sortBy)?.[1] || "Newest";
  b.title = `Sort: ${b.textContent}`;
}
(document.getElementById("btn-sort") as HTMLElement).addEventListener("click", () => {
  sortIdx = (sortIdx + 1) % SORT_CYCLE.length;
  setSortBy(SORT_CYCLE[sortIdx][0]);
  updateSortBtn();
  renderLibrary();
});
updateSortBtn();
(document.getElementById("btn-fav") as HTMLElement).addEventListener("click", () => {
  setFavOnly(!favOnly);
  (document.getElementById("btn-fav") as HTMLElement).classList.toggle("active", favOnly);
  renderLibrary();
});
