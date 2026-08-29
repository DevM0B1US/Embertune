import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import {
  createIcons,
  Folder,
  Heart,
  ListMusic,
  Maximize,
  Mic,
  Minimize,
  Minus,
  Music2,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Repeat,
  Settings,
  Shuffle,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Timer,
  Trash2,
  X,
} from "lucide";

export const ICONS = {
  Folder,
  Heart,
  ListMusic,
  Maximize,
  Mic,
  Minimize,
  Minus,
  Music2,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Repeat,
  Settings,
  Shuffle,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Timer,
  Trash2,
  X,
};

export function refreshIcons(): void {
  createIcons({ icons: ICONS });
}

export interface Track {
  id: number;
  title: string;
  artist: string;
  album: string;
  duration: number;
  path: string;
  source_url: string;
  source: string;
  added_at: number;
  favorite: boolean;
}

export interface JobView {
  id: number;
  url: string;
  kind: string;
  status: string;
  title: string;
  percent: number;
  downloaded: number;
  total: number;
  error: string | null;
  skipped: boolean;
  group_id: number | null;
  group_name: string;
  group_total: number;
  group_done: number;
  group_skipped: number;
  db_playlist: number | null;
}

export interface PlaylistTrackRow {
  id: number;
  title: string;
  status: string;
  percent: number;
  skipped?: boolean;
  downloaded?: number;
}

export interface PlaylistGroup {
  id: number;
  name: string;
  kind: string;
  total: number;
  done: number;
  failed: number;
  skipped: number;
  finished: boolean;
  db_playlist: number | null;
  fallback: boolean;
  tracks: Map<number, PlaylistTrackRow>;
}

export interface Playlist {
  id: number;
  name: string;
  created_at: number;
  track_count: number;
}

export interface PlayerState {
  playing: boolean;
  position: number;
  duration: number;
  volume: number;
  idle: boolean;
  current: Track | null;
  shuffle: boolean;
  repeat: string;
  speed: number;
  queue: Track[];
}

export interface SeekTarget {
  pct: number;
  secs: number;
  at: number;
}

export const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;

export function val(sel: string): string {
  return (document.querySelector(sel) as HTMLInputElement).value;
}

export function setVal(sel: string, v: string): void {
  (document.querySelector(sel) as HTMLInputElement).value = v;
}

export let tracks: Track[] = [];
export function setTracks(t: Track[]): void {
  tracks = t;
}
export const state = {
  playing: false,
  position: 0,
  duration: 0,
  volume: 100,
  idle: true,
  current: null as Track | null,
  shuffle: false,
  repeat: "off",
  speed: 1.0,
  queue: [] as Track[],
} as PlayerState;
export let playlists: Playlist[] = [];
export function setPlaylists(p: Playlist[]): void {
  playlists = p;
}
export let currentPlaylist: { id: number; name: string } | null = null;
export function setCurrentPlaylist(p: { id: number; name: string } | null): void {
  currentPlaylist = p;
}
export let favOnly = false;
export function setFavOnly(v: boolean): void {
  favOnly = v;
}
export let searchTerm = "";
export function setSearchTerm(s: string): void {
  searchTerm = s;
}
export let sortBy = "newest";
export function setSortBy(s: string): void {
  sortBy = s;
}
export let metaTrack: Track | null = null;
export function setMetaTrack(t: Track | null): void {
  metaTrack = t;
}
export let pendingAddTrack: Track | null = null;
export function setPendingAddTrack(t: Track | null): void {
  pendingAddTrack = t;
}
export let sleepEnd: number | null = null;
export function setSleepEnd(v: number | null): void {
  sleepEnd = v;
}
export let sleepTotalMin: number | null = null;
export function setSleepTotalMin(v: number | null): void {
  sleepTotalMin = v;
}
export let lastNowId: number | null = null;
export function setLastNowId(v: number | null): void {
  lastNowId = v;
}
export const artCache = new Map<number, string>();
export const downloads = new Map<number, JobView>();
export const playlistGroups = new Map<number, PlaylistGroup>();
export const dlRate = new Map<number, { t: number; bytes: number; rate: number }>();

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[c] || c,
  );
}

export function fmtDur(s: number): string {
  if (!s || s <= 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

// --- icons ---
export const ICON_PLAY = '<i data-lucide="Play" class="row-play-icon" width="13" height="13"></i>';
export const ICON_DEL = '<i data-lucide="Trash2" width="14" height="14"></i>';
export const ICON_EDIT = '<i data-lucide="Pencil" width="13" height="13"></i>';
export const ICON_ADD = '<i data-lucide="Plus" width="13" height="13"></i>';
export const ICON_HEART = (fav: boolean): string =>
  `<i data-lucide="Heart" width="13" height="13"${fav ? ' fill="currentColor"' : ""}></i>`;

// --- toast + notifications ---
let toastTimer: number | undefined;
export function toast(msg: string): void {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden", "leaving");
  void el.offsetWidth; // restart the entry animation
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.classList.add("leaving");
    window.setTimeout(() => el.classList.add("hidden"), 220);
  }, 3500);
}

export function notify(title: string, body: string): void {
  try {
    if (Notification.permission === "granted") {
      new Notification(title, { body });
    } else if (Notification.permission !== "denied") {
      Notification.requestPermission().then((p) => {
        if (p === "granted") new Notification(title, { body });
      });
    }
  } catch {
    /* webview has no Notification support — toast covers it */
  }
}

// --- UI sounds (tiny synthesized WebAudio pops; no assets, one shared ctx) ---
const sndState: { ctx: AudioContext | null } = { ctx: null };
export let sndEnabled = localStorage.getItem("embertune.sound") !== "off";
const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function sndResume(): void {
  try {
    if (sndState.ctx) {
      if (sndState.ctx.state === "suspended") void sndState.ctx.resume();
      return;
    }
    sndState.ctx = new AudioContext();
  } catch {
    sndState.ctx = null;
  }
}

function blip(freq: number, dur: number, vol: number, type: OscillatorType = "sine"): void {
  if (!sndEnabled || prefersReduced) return;
  sndResume();
  const ctx = sndState.ctx;
  if (!ctx || ctx.state !== "running") return;
  try {
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(45, freq * 0.55), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + dur + 0.03);
  } catch {
    /* audio is best-effort */
  }
}

export const sndClick = (): void => blip(340, 0.05, 0.028, "triangle");
export const sndOpen = (): void => blip(460, 0.08, 0.04);
export const sndClose = (): void => blip(250, 0.07, 0.035);
export const sndDone = (): void => {
  blip(540, 0.08, 0.045);
  blip(820, 0.12, 0.03);
};

// --- settings modal ---
export function closeSettings(): void {
  if ($("#settings-overlay").classList.contains("open")) sndClose();
  $("#settings-overlay").classList.remove("open");
  $("#btn-settings").classList.remove("active");
}

$("#btn-settings").addEventListener("click", () => {
  const open = !$("#settings-overlay").classList.contains("open");
  if (open) sndOpen();
  $("#settings-overlay").classList.toggle("open", open);
  $("#btn-settings").classList.toggle("active", open);
});
$("#btn-settings-close").addEventListener("click", closeSettings);

$("#settings-overlay").addEventListener("click", (e) => {
  if (e.target === $("#settings-overlay")) closeSettings();
});

// --- prompt / confirm dialog ---
let promptResolve: ((v: string | null) => void) | null = null;

function finishPrompt(v: string | null): void {
  if ($("#prompt-overlay").classList.contains("open")) sndClose();
  $("#prompt-overlay").classList.remove("open");
  if (promptResolve) {
    const r = promptResolve;
    promptResolve = null;
    r(v);
  }
}

export function promptDialog(
  title: string,
  opts: { message?: string; initial?: string; okText?: string } = {}
): Promise<string | null> {
  $("#prompt-title").textContent = title;
  const msg = $("#prompt-msg");
  if (opts.message) {
    msg.textContent = opts.message;
    msg.classList.remove("hidden");
  } else {
    msg.classList.add("hidden");
  }
  const input = $("#prompt-input") as HTMLInputElement;
  input.value = opts.initial ?? "";
  input.classList.remove("hidden");
  $("#prompt-ok").textContent = opts.okText ?? "OK";
  $("#prompt-overlay").classList.remove("confirm");
  return new Promise((resolve) => {
    promptResolve = resolve;
    $("#prompt-overlay").classList.add("open");
    input.focus();
    input.select();
  });
}

export function confirmDialog(message: string, okText = "Delete"): Promise<boolean> {
  $("#prompt-title").textContent = "Confirm";
  const msg = $("#prompt-msg");
  msg.textContent = message;
  msg.classList.remove("hidden");
  ($("#prompt-input") as HTMLInputElement).classList.add("hidden");
  $("#prompt-ok").textContent = okText;
  $("#prompt-overlay").classList.add("confirm");
  return new Promise((resolve) => {
    promptResolve = (v) => resolve(v !== null);
    $("#prompt-overlay").classList.add("open");
    sndOpen();
    $("#prompt-ok").focus();
  });
}

$("#prompt-ok").addEventListener("click", () => {
  const input = $("#prompt-input") as HTMLInputElement;
  const v = input.value.trim();
  finishPrompt(v.length ? v : null);
});
$("#prompt-cancel").addEventListener("click", () => finishPrompt(null));
$("#prompt-close").addEventListener("click", () => finishPrompt(null));
$("#prompt-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    ($("#prompt-ok") as HTMLButtonElement).click();
  } else if (e.key === "Escape") {
    finishPrompt(null);
  }
});
$("#prompt-overlay").addEventListener("click", (e) => {
  if (e.target === $("#prompt-overlay")) finishPrompt(null);
});

// --- drawers / menus ---
export function closeMenus(): void {
  $("#playlists-menu").classList.add("hidden");
  $("#queue-panel").classList.remove("open");
  $("#lyrics-panel").classList.remove("open");
  $("#eq-panel").classList.remove("open");
  $("#btn-queue").classList.remove("active");
  $("#btn-lyrics").classList.remove("active");
  $("#btn-eq").classList.remove("active");
}

// Close a drawer without its slide-out animation so two panels are never
// visible at once while swapping (prevents the layout getting pushed out).
export function instantClose(panel: HTMLElement, btn?: HTMLElement | null): void {
  panel.classList.add("instant");
  panel.classList.remove("open");
  if (btn) btn.classList.remove("active");
  requestAnimationFrame(() => panel.classList.remove("instant"));
}
export function setLyricsFs(on: boolean): void {
  $("#lyrics-panel").classList.toggle("fs", on);
  $("#lyrics-panel .icon-fs-max").classList.toggle("hidden", on);
  $("#lyrics-panel .icon-fs-min").classList.toggle("hidden", !on);
  if (on) sndOpen();
  else sndClose();
}

export function setSndEnabled(v: boolean): void {
  sndEnabled = v;
}
