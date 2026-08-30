import { invoke } from "@tauri-apps/api/core";
import { Heart, Pencil, Play, Trash2 } from "lucide";
import {
  $,
  val,
  setVal,
  esc,
  fmtDur,
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
import { attachSmoothWheel } from "./smoothwheel";
import type { Track } from "./lib";

// ═══════════════════════════════════════════════════════════════════
//  Virtualized library list — architecture
//
//  · Fixed row height (--row-h in CSS, mirrored in ROW_H here and
//    self-healed at runtime by measuring a real row) so index math is
//    pixel-exact even with 50k+ tracks.
//  · #track-list is position:relative with an explicit height — rows
//    are absolutely positioned shells translated with translate3d(),
//    so entering/leaving rows never reflow their siblings.
//  · Incremental window diff: scrolling only adds/removes the rows
//    that actually entered/left the window. No full teardown, no
//    per-scroll-frame innerHTML storms, no icon rescans (row icons are
//    pre-serialized SVG strings, not lucide placeholders).
//  · Entrance animation ("load one by one"): WAAPI fade+slide with a
//    capped per-row stagger on cold renders (initial load, search,
//    sort) and a quick micro-stagger for rows entering while
//    scrolling. Skipped entirely under prefers-reduced-motion.
// ═══════════════════════════════════════════════════════════════════

let ROW_H = 56; // mirrors --row-h; auto-corrected against real rows
const BUFFER = 8; // extra rows rendered above/below the viewport
const POOL_CAP = 64;
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");

const list = document.getElementById("track-list") as HTMLElement;
const view = document.getElementById("view-library") as HTMLElement;
const empty = document.getElementById("empty-library") as HTMLElement;
const libTitle = document.getElementById("lib-title") as HTMLElement;

// ── inline SVG icons (serialized once — zero runtime icon scans) ────
type IconNode = Array<[string, Record<string, string | number | undefined>]>;

function iconSvg(
  node: unknown,
  size: number,
  cls = "",
  fill = "none"
): string {
  const parts = node as IconNode;
  const body = parts
    .map(([tag, attrs]) => {
      const a = Object.entries(attrs)
        .map(([k, v]) => `${k}="${v}"`)
        .join(" ");
      return `<${tag} ${a}></${tag}>`;
    })
    .join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"` +
    ` viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="2"` +
    ` stroke-linecap="round" stroke-linejoin="round"${cls ? ` class="${cls}"` : ""}>` +
    `${body}</svg>`
  );
}

const SVG_PLAY = iconSvg(Play, 13, "row-play-icon");
const SVG_DEL = iconSvg(Trash2, 14);
const SVG_EDIT = iconSvg(Pencil, 13);
const SVG_HEART = iconSvg(Heart, 13, "", "none");
const SVG_HEART_FILLED = iconSvg(Heart, 13, "", "currentColor");

// ── data: master list + filtered view ───────────────────────────────
let viewItems: Track[] = [];
let hayIndex: Array<{ t: Track; hay: string }> = [];

function rebuildIndex(): void {
  hayIndex = tracks.map((t) => ({
    t,
    hay: `${t.title} ${t.artist} ${t.album}`.toLowerCase(),
  }));
}

const collTitle = new Intl.Collator(undefined, {
  sensitivity: "base",
  numeric: true,
});
const collArtist = new Intl.Collator(undefined, {
  sensitivity: "base",
  numeric: true,
});

function invalidateFilter(): void {
  let out: Track[];
  if (searchTerm || favOnly) {
    // single pass over the precomputed haystacks
    const q = searchTerm ? searchTerm.toLowerCase() : "";
    out = [];
    for (const { t, hay } of hayIndex) {
      if (favOnly && !t.favorite) continue;
      if (q && !hay.includes(q)) continue;
      out.push(t);
    }
  } else {
    out = hayIndex.map((e) => e.t);
  }
  switch (sortBy) {
    case "title":
      out = out.slice().sort((a, b) => collTitle.compare(a.title, b.title));
      break;
    case "artist":
      out = out.slice().sort((a, b) => collArtist.compare(a.artist, b.artist));
      break;
    case "duration":
      out = out.slice().sort((a, b) => a.duration - b.duration);
      break;
    default:
      out = out.slice().sort((a, b) => b.added_at - a.added_at);
  }
  viewItems = out;
}

// hayIndex is rebuilt only when the library itself changes (download
// finished, local import, metadata edit) — never per keystroke.

// ── row pool ────────────────────────────────────────────────────────
const pool: HTMLLIElement[] = [];
const rendered = new Map<number, HTMLLIElement>(); // view index → row
const trackRef = new WeakMap<HTMLElement, Track>();

function acquireRow(): HTMLLIElement {
  return pool.pop() ?? document.createElement("li");
}

function releaseRow(li: HTMLLIElement): void {
  li.remove();
  if (pool.length < POOL_CAP) pool.push(li);
}

function releaseAll(): void {
  for (const li of rendered.values()) {
    artObserver.unobserve(li);
    releaseRow(li);
  }
  rendered.clear();
}

// ── entrance animations (WAAPI — no CSS class juggling, no reflows) ─
function animateIn(trow: HTMLElement, delay: number, quick: boolean): void {
  if (REDUCED_MOTION.matches || typeof trow.animate !== "function") return;
  trow.animate(
    [
      { opacity: "0", transform: "translateY(7px)" },
      { opacity: "1", transform: "translateY(0)" },
    ],
    {
      duration: quick ? 150 : 280,
      delay,
      easing: quick
        ? "ease-out"
        : "cubic-bezier(0.22, 1, 0.36, 1)",
      fill: "backwards",
    }
  );
}

// ── artwork observer (single, shared, preloads 600px ahead) ─────────
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
      const img = li.querySelector(".track-art") as HTMLImageElement | null;
      if (img) setArt(img, artCache.get(t.id)!);
    }
    return;
  }
  try {
    const p = await invoke<string | null>("get_art", { trackId: t.id });
    if (p) {
      if (artCache.size >= 160) {
        const k = artCache.keys().next().value;
        if (k !== undefined) artCache.delete(k as number);
      }
      artCache.set(t.id, p);
      if (li.isConnected && li.dataset.id === String(t.id)) {
        const img = li.querySelector(".track-art") as HTMLImageElement | null;
        if (img) setArt(img, p);
      }
    }
  } catch {
    /* no art */
  }
}

// ── render one row ──────────────────────────────────────────────────
function renderRow(
  li: HTMLLIElement,
  t: Track,
  curId: number | null,
  playing: boolean
): void {
  li.className = "track";
  li.dataset.id = String(t.id);
  if (t.id === curId) {
    li.classList.add("playing");
    if (!playing) li.classList.add("paused");
  }

  li.innerHTML = `
    <div class="trow">
      <button class="play-btn" title="Play" aria-label="Play">${SVG_PLAY}</button>
      <img class="track-art hidden" alt="" draggable="false" loading="lazy" />
      <div class="track-meta">
        <div class="track-title" title="${esc(t.title)}${t.artist ? ` — ${esc(t.artist)}` : ""}">${esc(t.title)}</div>
        <div class="track-sub">${esc(t.artist || "—")} · ${fmtDur(t.duration)}</div>
      </div>
      <span class="track-src">${esc(t.source)}</span>
      <div class="row-actions">
        <button class="heart-btn${t.favorite ? " fav" : ""}" title="Favorite" aria-label="Favorite">${t.favorite ? SVG_HEART_FILLED : SVG_HEART}</button>
        <button class="edit-btn" title="Edit" aria-label="Edit">${SVG_EDIT}</button>
        <button class="del-btn" title="Delete" aria-label="Delete">${SVG_DEL}</button>
      </div>
    </div>`;

  // artwork — always reset first (pooled rows carry stale art)
  const img = li.querySelector(".track-art") as HTMLImageElement;
  img.classList.add("hidden");
  img.removeAttribute("src");
  if (artCache.has(t.id)) {
    setArt(img, artCache.get(t.id)!);
  } else {
    trackRef.set(li, t);
    artObserver.observe(li);
  }
}

// ── the window renderer (incremental diff) ──────────────────────────
let prevScrollTop = -1;
let prevFlushAt = 0;
let rafPending = false;

function currentWindow(): { start: number; end: number } {
  const total = viewItems.length;
  const scrollTop = view.scrollTop;
  const listTop = list.offsetTop;
  const viewH = view.clientHeight;
  const start = Math.max(
    0,
    Math.floor((scrollTop - listTop) / ROW_H) - BUFFER
  );
  const end = Math.min(
    total,
    Math.ceil((scrollTop + viewH - listTop) / ROW_H) + BUFFER
  );
  return { start, end };
}

function renderWindow(cold: boolean): void {
  const total = viewItems.length;
  if (total === 0) {
    releaseAll();
    return;
  }
  const { start, end } = currentWindow();

  // release rows that left the window
  for (const [i, li] of rendered) {
    if (i < start || i >= end) {
      artObserver.unobserve(li);
      releaseRow(li);
      rendered.delete(i);
    }
  }

  const curId = state.current?.id ?? null;
  const playing = !!state.playing;

  // scroll velocity — decides whether new rows get the cascade
  const now = performance.now();
  const dt = now - prevFlushAt;
  const vel =
    prevScrollTop >= 0 && dt > 0
      ? Math.abs(view.scrollTop - prevScrollTop) / dt
      : 0;
  prevScrollTop = view.scrollTop;
  prevFlushAt = now;
  const animateRows = cold || vel < 4; // px/ms — don't animate during flings

  let batch = 0;
  for (let i = start; i < end; i++) {
    if (rendered.has(i)) continue;
    const li = acquireRow();
    renderRow(li, viewItems[i], curId, playing);
    li.style.transform = `translate3d(0, ${i * ROW_H}px, 0)`;
    list.appendChild(li);
    rendered.set(i, li);
    if (animateRows) {
      const trow = li.firstElementChild as HTMLElement | null;
      if (trow) {
        if (cold) {
          animateIn(trow, Math.min((i - start) * 24, 340), false);
        } else {
          animateIn(trow, Math.min(batch * 12, 72), true);
        }
      }
    }
    batch++;
  }
}

function scheduleFlush(): void {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    renderWindow(false);
  });
}

view.addEventListener(
  "scroll",
  () => {
    scheduleFlush();
  },
  { passive: true }
);

// buttery wheel scrolling (WebKitGTK wheel steps are chunky; this
// lerps scrollTop on a rAF loop for a smooth, inertial feel)
attachSmoothWheel(view);

// keep ROW_H in sync with CSS (theme/media-query changes, zoom, DPR)
let resizeTimer: number | undefined;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(adoptRowHeight, 150);
});

function adoptRowHeight(): void {
  const li = rendered.values().next().value as HTMLLIElement | undefined;
  const h = li?.getBoundingClientRect().height ?? 0;
  if (h > 8 && Math.abs(h - ROW_H) > 0.5) {
    ROW_H = h;
    // keep CSS and JS in exact agreement — positions are i * ROW_H
    document.documentElement.style.setProperty("--row-h", `${h}px`);
    applyListHeight();
    releaseAll();
    renderWindow(true);
  }
}

function applyListHeight(): void {
  list.style.height = `${viewItems.length * ROW_H}px`;
}

// ── public API ──────────────────────────────────────────────────────

export async function refreshLibrary(): Promise<void> {
  setTracks(await invoke<Track[]>("get_library"));
  rebuildIndex();
  renderLibrary();
}

export function renderLibrary(opts?: { resetScroll?: boolean }): void {
  invalidateFilter();
  applyListHeight();

  const shown = viewItems.length;
  empty.classList.toggle("hidden", shown > 0 || downloads.size > 0);
  empty.textContent =
    tracks.length === 0
      ? "Nothing here yet. Drop a URL above."
      : "No matches.";

  const total = tracks.length;
  libTitle.textContent =
    total === 0
      ? "Library"
      : shown === total
        ? `Library · ${total.toLocaleString()}`
        : `${shown.toLocaleString()} / ${total.toLocaleString()}`;

  releaseAll();
  if (opts?.resetScroll) view.scrollTop = 0;
  renderWindow(true);
  // one-shot self-heal: if CSS and ROW_H ever disagree (zoom, media
  // query), reconcile now that a real row exists to measure
  adoptRowHeight();
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
    const prev = list.querySelector<HTMLElement>(
      `.track[data-id="${prevId}"]`
    );
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
  // optimistic highlight — don't wait up to a full poll cycle for the
  // backend to echo the state back
  if (id !== (state.current?.id ?? null)) {
    markRowPlayingOptimistic(id);
  }
}

function markRowPlayingOptimistic(id: number): void {
  const row = list.querySelector<HTMLElement>(`.track[data-id="${id}"]`);
  if (!row) return;
  const prevId = _lastPlayingId;
  _lastPlayingId = id;
  _lastPlaying = true;
  if (prevId !== null && prevId !== id) {
    const prev = list.querySelector<HTMLElement>(
      `.track[data-id="${prevId}"]`
    );
    if (prev) prev.classList.remove("playing", "paused");
  }
  row.classList.add("playing");
  row.classList.remove("paused");
}

// ── event delegation (one listener for the whole list) ──────────────

list.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const row = target.closest<HTMLElement>(".track");
  if (!row || !row.dataset.id) return;
  const id = Number(row.dataset.id);
  const t =
    viewItems.find((x) => x.id === id) ?? tracks.find((x) => x.id === id);
  if (!t) return;

  if (target.closest(".heart-btn")) {
    e.stopPropagation();
    void toggleFav(t, target.closest<HTMLElement>(".heart-btn"));
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

// ── favorites (in-place icon update — no list rebuild) ──────────────

function paintHeart(btn: HTMLElement, fav: boolean): void {
  btn.classList.toggle("fav", fav);
  const svg = btn.querySelector("svg");
  if (svg) svg.setAttribute("fill", fav ? "currentColor" : "none");
}

async function toggleFav(
  t: Track,
  btn: HTMLElement | null
): Promise<void> {
  const before = t.favorite;
  t.favorite = !before;
  if (btn) paintHeart(btn, t.favorite);
  try {
    await invoke("set_favorite", { id: t.id, favorite: t.favorite });
  } catch {
    t.favorite = before;
    if (btn) paintHeart(btn, before);
    return;
  }
  // in favorites-only mode the row must leave/enter the list
  if (favOnly) renderLibrary();
}

// ── delete ──────────────────────────────────────────────────────────

async function deleteTrack(t: Track): Promise<void> {
  if (
    !(await confirmDialog(
      `Delete "${t.title}" from the library and disk?`,
      "Delete"
    ))
  )
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
    m = await invoke<TrackMetaInfo | null>("get_track_meta", {
      trackId: t.id,
    });
  } catch {
    m = null;
  }
  if (!m) {
    box.textContent = "No technical metadata available.";
    return;
  }
  const bits = (b: number) => (b > 0 ? `${(b / 1000).toFixed(0)} kbps` : "—");
  const sz = (s: number) =>
    s > 0 ? `${(s / 1024 / 1024).toFixed(1)} MB` : "—";
  box.innerHTML = (
    [
      ["Format", m.format || "—"],
      ["Codec", m.codec || "—"],
      ["Bitrate", bits(m.bitrate)],
      [
        "Sample rate",
        m.sample_rate > 0 ? `${m.sample_rate} Hz` : "—",
      ],
      ["Channels", m.channels > 0 ? String(m.channels) : "—"],
      ["Duration", m.duration > 0 ? fmtDur(m.duration) : "—"],
      ["Size", sz(m.size)],
    ] as Array<[string, string]>
  )
    .map(
      ([k, v]) =>
        `<div class="meta-row"><span>${k}</span><b>${esc(v)}</b></div>`
    )
    .join("");
}

(
  document.getElementById("meta-cancel") as HTMLElement
).addEventListener("click", () => {
  sndClose();
  (document.getElementById("meta-overlay") as HTMLElement).classList.remove(
    "open"
  );
});

(
  document.getElementById("meta-overlay") as HTMLElement
).addEventListener("click", (e) => {
  if (e.target === document.getElementById("meta-overlay")) {
    sndClose();
    (document.getElementById("meta-overlay") as HTMLElement).classList.remove(
      "open"
    );
  }
});

(
  document.getElementById("meta-save") as HTMLElement
).addEventListener("click", async () => {
  if (!metaTrack) return;
  await invoke("update_track_meta", {
    id: metaTrack.id,
    title: val("#meta-title").trim() || metaTrack.title,
    artist: val("#meta-artist").trim(),
    album: val("#meta-album").trim(),
  });
  sndDone();
  (document.getElementById("meta-overlay") as HTMLElement).classList.remove(
    "open"
  );
  await refreshLibrary();
});

// ── search / sort / favorites ───────────────────────────────────────

let searchTimer: number | undefined;
(
  document.getElementById("search") as HTMLInputElement
).addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    const next = (e.target as HTMLInputElement).value.trim();
    if (next === searchTerm) return;
    setSearchTerm(next);
    renderLibrary({ resetScroll: true });
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

(
  document.getElementById("btn-sort") as HTMLElement
).addEventListener("click", () => {
  sortIdx = (sortIdx + 1) % SORTS.length;
  setSortBy(SORTS[sortIdx][0]);
  updateSortBtn();
  renderLibrary({ resetScroll: true });
});

updateSortBtn();

(
  document.getElementById("btn-fav") as HTMLElement
).addEventListener("click", () => {
  setFavOnly(!favOnly);
  (document.getElementById("btn-fav") as HTMLElement).classList.toggle(
    "active",
    favOnly
  );
  renderLibrary({ resetScroll: true });
});
