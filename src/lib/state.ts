import { createRoot, createSignal, createMemo } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { sndDone, sndOpen, sndClose } from "./sounds";
import type { AppSettings, PlayerState, Track } from "./types";

// ═══════════════════════════════════════════════════════════════════
//  Global reactive state — the single source of truth for the UI.
//  Every module-level computation lives inside one createRoot so
//  memos/effects are owned for the app's lifetime.
// ═══════════════════════════════════════════════════════════════════

export const [tracks, setTracks] = createSignal<Track[]>([]);

// ── library view state ──────────────────────────────────────────────
export const [searchTerm, setSearchTerm] = createSignal("");
export const [favOnly, setFavOnly] = createSignal(false);
export const [sortBy, setSortBy] = createSignal("newest");

// Generation counter: bumped whenever the filtered view is rebuilt
// (search / sort / fav filter / library refresh). The track list uses
// it to key rows, so a bump replays entrance animations exactly like
// the old cold render did.
const [genSig, setGenSig] = createSignal(0);
export const viewGen = genSig;
let resetNext = false;

export function invalidateView(resetScroll = false): void {
  if (resetScroll) resetNext = true;
  setGenSig((g) => g + 1);
}

export function consumeReset(): boolean {
  const r = resetNext;
  resetNext = false;
  return r;
}

// ── player ──────────────────────────────────────────────────────────
export const [player, setPlayer] = createSignal<PlayerState>({
  playing: false,
  position: 0,
  duration: 0,
  volume: 100,
  idle: true,
  current: null,
  shuffle: false,
  repeat: "off",
  speed: 1.0,
});

// Which row shows the "playing" highlight. Written by the poll (truth)
// and optimistically by playTrack — last write wins, exactly like the
// old _lastPlayingId scheme but fully reactive.
export const [playHi, setPlayHi] = createSignal<{ id: number | null; playing: boolean }>({
  id: null,
  playing: false,
});

export function playTrack(id: number): void {
  void invoke("play_track", { id });
  if (id !== (player().current?.id ?? null)) {
    setPlayHi({ id, playing: true });
  }
}

// ── downloads ───────────────────────────────────────────────────────
// Source of truth (plain map, mutated as events arrive); the reactive
// list is flushed from it on the same ~8fps coalescing the old
// renderer used — progress events arrive several times per second.
export const dlMap = new Map<number, import("./types").JobView>();
export const [dlList, setDlList] = createSignal<import("./types").JobView[]>([]);
export const dlRate = new Map<number, { t: number; bytes: number; rate: number }>();

let lastDlRender = 0;
let dlTimer: number | undefined;

function flushDl(): void {
  setDlList([...dlMap.values()]);
  for (const [id] of dlRate) if (!dlMap.has(id)) dlRate.delete(id);
}

export function scheduleDlRender(): void {
  const now = performance.now();
  const dt = now - lastDlRender;
  if (dt >= 120) {
    lastDlRender = now;
    flushDl();
    return;
  }
  if (dlTimer === undefined) {
    dlTimer = window.setTimeout(() => {
      dlTimer = undefined;
      lastDlRender = performance.now();
      flushDl();
    }, 120 - dt);
  }
}

export function ingestJob(j: import("./types").JobView): void {
  if (j.status === "completed" || j.status === "error" || j.status === "cancelled") {
    if (j.status === "completed") sndDone();
    if (j.status === "error") toast(`Download failed: ${j.error || "unknown"}`);
    dlMap.delete(j.id);
  } else {
    dlMap.set(j.id, j);
  }
  scheduleDlRender();
}

export async function queueUrl(url: string): Promise<void> {
  const id = await invoke<number>("add_download", { url });
  dlMap.set(id, {
    id,
    url,
    kind: url.includes("spotify") || url.startsWith("spotify:") ? "spotify" : "youtube",
    status: "queued",
    title: url,
    percent: -1,
    downloaded: 0,
    total: 0,
    error: null,
    skipped: false,
  });
  scheduleDlRender();
}

// ── settings ────────────────────────────────────────────────────────
export const [settings, setSettings] = createSignal<AppSettings>({
  spotify_client_id: null,
  has_spotify_creds: false,
  quality: "best",
  theme: "glass",
  window_controls: false,
});
export const [dlDir, setDlDir] = createSignal("");
export const [engineLog, setEngineLog] = createSignal<string | null>(null);

// ── overlays / ui ───────────────────────────────────────────────────
export const [settingsOpen, setSettingsOpen] = createSignal(false);
export const [lyricsOpen, setLyricsOpen] = createSignal(false);
const [lyricsFsSig, setLyricsFsSig] = createSignal(false);
export const lyricsFs = lyricsFsSig;
export const [metaOpen, setMetaOpen] = createSignal(false);
export const [metaTrack, setMetaTrack] = createSignal<Track | null>(null);

export function closeSettings(): void {
  if (settingsOpen()) sndClose();
  setSettingsOpen(false);
}

export function openSettings(): void {
  setSettingsOpen((o) => !o);
  if (settingsOpen()) sndOpen();
}

export function setLyricsFs(on: boolean): void {
  setLyricsFsSig(on);
  if (on) sndOpen();
  else sndClose();
}

export function openMeta(t: Track): void {
  setMetaTrack(t);
  setMetaOpen(true);
  sndOpen();
}

export function closeMeta(): void {
  setMetaOpen(false);
  sndClose();
}

// ── prompt / confirm dialog ─────────────────────────────────────────
export interface PromptState {
  open: boolean;
  confirm: boolean;
  title: string;
  msg: string;
  showMsg: boolean;
  showInput: boolean;
  initial: string;
  okText: string;
}

export const [prompt, setPrompt] = createSignal<PromptState>({
  open: false,
  confirm: false,
  title: "",
  msg: "",
  showMsg: false,
  showInput: true,
  initial: "",
  okText: "OK",
});

// refs registered by the PromptDialog component (focus management)
export const promptEls: { input?: HTMLInputElement; ok?: HTMLButtonElement } = {};

let promptResolve: ((v: string | null) => void) | null = null;

export function finishPrompt(v: string | null): void {
  if (prompt().open) sndClose();
  setPrompt((p) => ({ ...p, open: false }));
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
  setPrompt({
    open: true,
    confirm: false,
    title,
    msg: opts.message ?? "",
    showMsg: !!opts.message,
    showInput: true,
    initial: opts.initial ?? "",
    okText: opts.okText ?? "OK",
  });
  return new Promise((resolve) => {
    promptResolve = resolve;
    queueMicrotask(() => {
      // set imperatively (not reactively) so re-opening with the same
      // initial never shows stale typed text
      if (promptEls.input) promptEls.input.value = opts.initial ?? "";
      promptEls.input?.focus();
      promptEls.input?.select();
    });
  });
}

export function confirmDialog(message: string, okText = "Delete"): Promise<boolean> {
  setPrompt({
    open: true,
    confirm: true,
    title: "Confirm",
    msg: message,
    showMsg: true,
    showInput: false,
    initial: "",
    okText,
  });
  return new Promise((resolve) => {
    promptResolve = (v) => resolve(v !== null);
    sndOpen();
    queueMicrotask(() => {
      // FIX vs vanilla build: the input is cleared in confirm mode.
      // The old code resolved OK against whatever stale text the input
      // still held, so an empty input made "Delete" silently no-op.
      if (promptEls.input) promptEls.input.value = "";
      promptEls.ok?.focus();
    });
  });
}

// ── toast ───────────────────────────────────────────────────────────
export const [toastSt, setToastSt] = createSignal<{ text: string; hidden: boolean; leaving: boolean }>({
  text: "",
  hidden: true,
  leaving: false,
});
export const toastEls: { el?: HTMLElement } = {};
let toastTimer: number | undefined;
let toastLeaveTimer: number | undefined;

export function toast(msg: string): void {
  setToastSt({ text: msg, hidden: false, leaving: false });
  const el = toastEls.el;
  if (el) void el.offsetWidth; // restart the entry animation
  clearTimeout(toastTimer);
  clearTimeout(toastLeaveTimer);
  toastTimer = window.setTimeout(() => {
    setToastSt((s) => ({ ...s, leaving: true }));
    toastLeaveTimer = window.setTimeout(() => setToastSt((s) => ({ ...s, hidden: true })), 220);
  }, 3500);
}

// ── sleep timer state (logic in lib/sleep.ts) ───────────────────────
export const [sleepEnd, setSleepEnd] = createSignal<number | null>(null);
export const [sleepTotalMin, setSleepTotalMin] = createSignal<number | null>(null);

// ── shared caches ───────────────────────────────────────────────────
export const artCache = new Map<number, string>();

export function cacheArt(id: number, p: string): void {
  if (artCache.size >= 160) {
    const k = artCache.keys().next().value;
    if (k !== undefined) artCache.delete(k as number);
  }
  artCache.set(id, p);
}

// ── derived library views (module-owned memos) ──────────────────────
const owner = createRoot(() => {
  // haystack index — rebuilt only when the library itself changes,
  // never per keystroke (same caching contract as the vanilla build)
  const hayIndex = createMemo(() =>
    tracks().map((t) => ({
      t,
      hay: `${t.title} ${t.artist} ${t.album}`.toLowerCase(),
    }))
  );

  const collTitle = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
  const collArtist = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

  const viewItems = createMemo<Track[]>(() => {
    viewGen(); // dependency — replay animations on filter changes
    const fav = favOnly();
    const q = searchTerm() ? searchTerm().toLowerCase() : "";
    let out: Track[];
    if (q || fav) {
      out = [];
      for (const { t, hay } of hayIndex()) {
        if (fav && !t.favorite) continue;
        if (q && !hay.includes(q)) continue;
        out.push(t);
      }
    } else {
      out = hayIndex().map((e) => e.t);
    }
    switch (sortBy()) {
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
    return out;
  });

  const shownCount = createMemo(() => viewItems().length);
  const totalCount = createMemo(() => tracks().length);

  const libTitle = createMemo(() => {
    const total = totalCount();
    const shown = shownCount();
    if (total === 0) return "Library";
    return shown === total
      ? `Library · ${total.toLocaleString()}`
      : `${shown.toLocaleString()} / ${total.toLocaleString()}`;
  });

  // deduped current-track id — safe on() source (on() does NOT dedupe:
  // it refires on every player() write, i.e. every poll)
  const currentId = createMemo(() => player().current?.id ?? null);

  return { hayIndex, viewItems, libTitle, totalCount, currentId };
});

export const viewItems = owner.viewItems;
export const libTitle = owner.libTitle;
export const totalCount = owner.totalCount;
export const currentId = owner.currentId;

// ── library refresh ─────────────────────────────────────────────────
export async function refreshLibrary(): Promise<void> {
  setTracks(await invoke<Track[]>("get_library"));
  invalidateView(false);
}
