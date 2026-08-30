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

// ── virtual scroll engine ───────────────────────────────────────────
const ROW_H = 46;
const BUFFER = 8;
let lastStart = -1;
let lastEnd = -1;
let rafPending = false;
const list = document.getElementById("track-list") as HTMLElement;
const view = document.getElementById("view-library") as HTMLElement;
const empty = document.getElementById("empty-library") as HTMLElement;
const trackRef = new WeakMap<HTMLElement, Track>();
const artObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const el = e.target as HTMLElement;
      artObserver.unobserve(el);
      const t = trackRef.get(el);
      if (t) void loadArt(t, el);
    }
  },
  { root: view, rootMargin: "600px 0px", threshold: 0 }
);

function shown(): Track[] {
  let out = tracks;
  if (favOnly) out = out.filter((t) => t.favorite);
  if (searchTerm) {
    const q = searchTerm.toLowerCase();
    out = out.filter((t) =>
      `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q)
    );
  }
  return [...out].sort((a, b) => {
    if (sortBy === "title") return a.title.localeCompare(b.title);
    if (sortBy === "artist") return a.artist.localeCompare(b.artist);
    if (sortBy === "duration") return a.duration - b.duration;
    return b.added_at - a.added_at;
  });
}

function onScroll(): void {
  if (!rafPending) {
    rafPending = true;
    requestAnimationFrame(renderVisible);
  }
}

view.addEventListener("scroll", onScroll, { passive: true });

function renderVisible(): void {
  rafPending = false;
  const items = shown();
  const total = items.length;
  const scrollTop = view.scrollTop;
  const viewH = view.clientHeight;
  const maxScroll = Math.max(0, total * ROW_H - viewH);
  const clamped = Math.min(scrollTop, maxScroll);

  const start = Math.max(0, Math.floor(clamped / ROW_H) - BUFFER);
  const end = Math.min(total, Math.ceil((clamped + viewH) / ROW_H) + BUFFER);

  if (start === lastStart && end === lastEnd) return;
  lastStart = start;
  lastEnd = end;

  list.style.paddingTop = `${start * ROW_H}px`;
  list.style.paddingBottom = `${Math.max(0, (total - end) * ROW_H)}px`;

  const curId = state.current?.id ?? null;
  const playing = !!state.playing;
  const frag = document.createDocumentFragment();

  for (let i = start; i < end; i++) {
    frag.appendChild(makeRow(items[i], curId, playing));
  }

  list.replaceChildren(frag);
  refreshIcons();
}

function makeRow(t: Track, curId: number | null, playing: boolean): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "track in";
  li.dataset.id = String(t.id);
  if (t.id === curId) {
    li.classList.add("playing");
    if (!playing) li.classList.add("paused");
  }
  li.innerHTML = `
    <button class="play-btn" title="Play">${ICON_PLAY}</button>
    <img class="track-art hidden" alt="" draggable="false" loading="lazy" />
    <div class="track-meta">
      <div class="track-title">${esc(t.title)}</div>
      <div class="track-sub">${esc(t.artist || "—")} · ${fmtDur(t.duration)}</div>
    </div>
    <span class="track-src">${esc(t.source)}</span>
    <div class="row-actions">
      <button class="heart-btn${t.favorite ? " fav" : ""}" title="Favorite">${ICON_HEART(t.favorite)}</button>
      <button class="edit-btn" title="Edit">${ICON_EDIT}</button>
      <button class="del-btn" title="Delete">${ICON_DEL}</button>
    </div>`;

  const img = li.querySelector(".track-art") as HTMLImageElement;
  if (artCache.has(t.id)) {
    setArt(img, artCache.get(t.id)!);
  } else {
    trackRef.set(li, t);
    artObserver.observe(li);
  }

  return li;
}

function setArt(img: HTMLImageElement, src: string): void {
  if (img.dataset.bound !== "1") {
    img.dataset.bound = "1";
    img.addEventListener("error", () => {
      img.classList.add("hidden");
      img.removeAttribute("src");
    });
  }
  img.src = src;
  img.classList.remove("hidden");
}

async function loadArt(t: Track, li: HTMLElement): Promise<void> {
  if (artCache.has(t.id)) {
    if (li.isConnected && li.dataset.id === String(t.id)) {
      const img = li.querySelector(".track-art") as HTMLImageElement;
      if (img) setArt(img, artCache.get(t.id)!);
    }
    return;
  }
  try {
    const p = await invoke<string | null>("get_art", { trackId: t.id });
    if (p) {
      if (artCache.size >= 120) {
        const k = artCache.keys().next().value;
        if (k !== undefined) artCache.delete(k as number);
      }
      artCache.set(t.id, p);
      if (li.isConnected && li.dataset.id === String(t.id)) {
        const img = li.querySelector(".track-art") as HTMLImageElement;
        if (img) setArt(img, p);
      }
    }
  } catch {
    /* no art */
  }
}

// ── public API ──────────────────────────────────────────────────────

export async function refreshLibrary(): Promise<void> {
  setTracks(await invoke<Track[]>("get_library"));
  renderLibrary();
}

export function renderLibrary(): void {
  lastStart = -1;
  lastEnd = -1;
  const items = shown();
  empty.classList.toggle("hidden", items.length > 0 || downloads.size > 0);
  empty.textContent =
    tracks.length === 0 ? "Nothing here yet. Drop a URL above." : "No matches.";
  renderVisible();
}

let _lastPlayingId: number | null = null;
let _lastPlaying = false;

export function markPlayingRow(): void {
  const curId = state.current?.id ?? null;
  const playing = !!state.playing;
  if (curId === _lastPlayingId && playing === _lastPlaying) return;

  const prevId = _lastPlayingId;
  _lastPlayingId = curId;
  _lastPlaying = playing;

  if (prevId !== null && prevId !== curId) {
    const prev = list.querySelector<HTMLElement>(`.track[data-id="${prevId}"]`);
    if (prev) prev.classList.remove("playing", "paused");
  }
  if (curId !== null) {
    const row = list.querySelector<HTMLElement>(`.track[data-id="${curId}"]`);
    if (row) {
      row.classList.add("playing");
      row.classList.toggle("paused", !playing);
    }
  }
}

export function playTrack(id: number): void {
  void invoke("play_track", { id });
}

// ── event delegation ────────────────────────────────────────────────

list.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const row = target.closest<HTMLElement>(".track");
  if (!row || !row.dataset.id) return;
  const id = Number(row.dataset.id);
  const items = shown();
  const t = items.find((x) => x.id === id) ?? tracks.find((x) => x.id === id);
  if (!t) return;

  if (target.closest(".heart-btn")) {
    e.stopPropagation();
    void toggleFav(t);
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
  if (!target.closest(".row-actions")) playTrack(id);
});

// ── favorites ───────────────────────────────────────────────────────

async function toggleFav(t: Track): Promise<void> {
  t.favorite = !t.favorite;
  await invoke("set_favorite", { id: t.id, favorite: t.favorite });
  renderLibrary();
}

// ── delete ──────────────────────────────────────────────────────────

async function deleteTrack(t: Track): Promise<void> {
  if (!(await confirmDialog(`Delete "${t.title}" from the library and disk?`, "Delete")))
    return;
  await invoke("remove_track", { id: t.id });
  await refreshLibrary();
}

// ── metadata edit ───────────────────────────────────────────────────

function openMeta(t: Track): void {
  setMetaTrack(t);
  setVal("#meta-title", t.title);
  setVal("#meta-artist", t.artist || "");
  setVal("#meta-album", t.album || "");
  ($("#meta-overlay") as HTMLElement).classList.add("open");
  sndOpen();
  void loadMeta(t);
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

async function loadMeta(t: Track): Promise<void> {
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
  const bits = (b: number) => (b > 0 ? `${(b / 1000).toFixed(0)} kbps` : "—");
  const sz = (s: number) => (s > 0 ? `${(s / 1024 / 1024).toFixed(1)} MB` : "—");
  box.innerHTML = (
    [
      ["Format", m.format || "—"],
      ["Codec", m.codec || "—"],
      ["Bitrate", bits(m.bitrate)],
      ["Sample rate", m.sample_rate > 0 ? `${m.sample_rate} Hz` : "—"],
      ["Channels", m.channels > 0 ? String(m.channels) : "—"],
      ["Duration", m.duration > 0 ? fmtDur(m.duration) : "—"],
      ["Size", sz(m.size)],
    ] as Array<[string, string]>
  )
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

// ── search / sort / favorites ───────────────────────────────────────

let searchTimer: number | undefined;
(document.getElementById("search") as HTMLInputElement).addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    setSearchTerm((e.target as HTMLInputElement).value.trim());
    renderLibrary();
  }, 120);
});

const SORTS: Array<[string, string]> = [
  ["newest", "Newest"],
  ["title", "A–Z"],
  ["artist", "Artist"],
  ["duration", "Dur"],
];
let sortIdx = 0;

function updateSortBtn(): void {
  const b = document.getElementById("btn-sort") as HTMLElement;
  b.dataset.sort = sortBy;
  b.textContent = SORTS.find(([k]) => k === sortBy)?.[1] || "Newest";
  b.title = `Sort: ${b.textContent}`;
}

(document.getElementById("btn-sort") as HTMLElement).addEventListener("click", () => {
  sortIdx = (sortIdx + 1) % SORTS.length;
  setSortBy(SORTS[sortIdx][0]);
  updateSortBtn();
  renderLibrary();
});

updateSortBtn();

(document.getElementById("btn-fav") as HTMLElement).addEventListener("click", () => {
  setFavOnly(!favOnly);
  (document.getElementById("btn-fav") as HTMLElement).classList.toggle("active", favOnly);
  renderLibrary();
});
