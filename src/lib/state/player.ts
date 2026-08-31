import { invoke } from "@tauri-apps/api/core";
import { createMemo, createRoot, createSignal } from "solid-js";
import type { PlayerState } from "../types";

// ═══════════════════════════════════════════════════════════════════
//  Player store — single source of truth for playback state.
//
//  The backend is polled on an adaptive cadence; results are written
//  only when something actually changed, and fields the user just
//  touched locally (volume / shuffle / repeat / speed) are shielded
//  for a short window so stale poll echoes cannot flicker the UI.
//  Row-highlight ids get an optimistic override so clicking a track
//  highlights it instantly, without waiting for the next poll.
// ═══════════════════════════════════════════════════════════════════

const IDLE_STATE: PlayerState = {
  playing: false,
  position: 0,
  duration: 0,
  volume: 100,
  idle: true,
  current: null,
  shuffle: false,
  repeat: "off",
  speed: 1.0,
};

const playerOwner = createRoot(() => {
  const [player, setPlayer] = createSignal<PlayerState>(IDLE_STATE);

  // ── deduped derived accessors ─────────────────────────────────
  // Memos propagate only when the value actually changed, so the
  // whole UI can safely read these instead of the whole state object
  // (which is replaced on every poll while playing).
  const isPlaying = createMemo(() => player().playing);
  const position = createMemo(() => player().position);
  const duration = createMemo(() => player().duration);
  const volume = createMemo(() => player().volume);
  const shuffle = createMemo(() => player().shuffle);
  const repeat = createMemo(() => player().repeat);
  const speed = createMemo(() => player().speed);
  const currentTrack = createMemo(() => player().current);

  // ── optimistic current-track highlight ────────────────────────────
  const [pendingId, setPendingId] = createSignal<number | null>(null);

  /** The track that should be highlighted: the optimistic pick wins
   *  until the poll confirms it (or the attempt fails/times out). */
  const currentId = createMemo<number | null>(() => {
    const pending = pendingId();
    if (pending !== null) return pending;
    return player().current?.id ?? null;
  });

  /** Row-highlight "playing" state: real playback, or optimistic
   *  playing=true right after the user clicks a row. */
  const highlightPlaying = createMemo(() => player().playing || pendingId() !== null);

  // ── local-echo shield (poll must not flicker fresh local edits) ───
  const localEditAt: Partial<Record<"volume" | "shuffle" | "repeat" | "speed", number>> = {};
  const LOCAL_ECHO_MS = 600;

  function markLocalEdit(field: keyof typeof localEditAt): void {
    localEditAt[field] = Date.now();
  }

  function sameState(a: PlayerState, b: PlayerState): boolean {
    return (
      a.playing === b.playing &&
      a.position === b.position &&
      a.duration === b.duration &&
      a.volume === b.volume &&
      a.idle === b.idle &&
      a.shuffle === b.shuffle &&
      a.repeat === b.repeat &&
      a.speed === b.speed &&
      (a.current?.id ?? null) === (b.current?.id ?? null)
    );
  }

  /** Merge a poll result into the store; returns true when it changed. */
  function syncFromBackend(ps: PlayerState): boolean {
    const cur = player();
    if (sameState(cur, ps)) return false;
    const now = Date.now();
    const merged: PlayerState =
      now - (localEditAt.volume ?? 0) < LOCAL_ECHO_MS ||
      now - (localEditAt.shuffle ?? 0) < LOCAL_ECHO_MS ||
      now - (localEditAt.repeat ?? 0) < LOCAL_ECHO_MS ||
      now - (localEditAt.speed ?? 0) < LOCAL_ECHO_MS
        ? {
            ...ps,
            volume: now - (localEditAt.volume ?? 0) < LOCAL_ECHO_MS ? cur.volume : ps.volume,
            shuffle: now - (localEditAt.shuffle ?? 0) < LOCAL_ECHO_MS ? cur.shuffle : ps.shuffle,
            repeat: now - (localEditAt.repeat ?? 0) < LOCAL_ECHO_MS ? cur.repeat : ps.repeat,
            speed: now - (localEditAt.speed ?? 0) < LOCAL_ECHO_MS ? cur.speed : ps.speed,
          }
        : ps;
    setPlayer(merged);
    return true;
  }

  // ── poll loop ─────────────────────────────────────────────────────
  let pollTimer: number | undefined;
  let running = false;

  async function pollOnce(): Promise<void> {
    let ps: PlayerState;
    try {
      ps = await invoke<PlayerState>("get_player_state");
    } catch {
      return; // backend unavailable — keep last known state
    }
    const changed = syncFromBackend(ps);
    if (!changed) return;
    const backendId = ps.current?.id ?? null;
    setPendingId((pending) => (pending !== null && pending === backendId ? null : pending));
  }

  function schedule(): void {
    const delay = document.hidden ? 1000 : player().playing ? 500 : 900;
    pollTimer = window.setTimeout(async () => {
      await pollOnce();
      if (running) schedule();
    }, delay);
  }

  /** Start the adaptive poll + initial state fetch. Returns cleanup. */
  function startPlayerSync(): () => void {
    const stop = (): void => {
      running = false;
      window.clearTimeout(pollTimer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    if (running) return stop;
    running = true;
    void pollOnce();
    schedule();
    const onVisibility = (): void => {
      if (!document.hidden) void pollOnce();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return stop;
  }

  // ── actions ───────────────────────────────────────────────────────
  function playTrack(id: number): void {
    setPendingId(id);
    void invoke("play_track", { id }).catch(() => {
      setPendingId((pending) => (pending === id ? null : pending));
    });
    // safety net: never keep an unconfirmed highlight for long
    window.setTimeout(() => {
      setPendingId((pending) =>
        pending === id && (player().current?.id ?? null) !== id ? null : pending
      );
    }, 1500);
  }

  const togglePlay = (): void => void invoke("toggle_play");
  const nextTrack = (): void => void invoke("player_next");
  const prevTrack = (): void => void invoke("player_prev");
  const seekTo = (secs: number): void =>
    void invoke("player_seek", { secs: Math.max(0, secs) });

  // volume — optimistic, with trailing throttle on the IPC call
  let volumeTimer: number | undefined;
  let volumeLast = -1;

  function invokeVolume(v: number): void {
    volumeLast = v;
    if (volumeTimer !== undefined) return;
    volumeTimer = window.setTimeout(() => {
      volumeTimer = undefined;
      void invoke("player_set_volume", { volume: volumeLast });
    }, 90);
  }

  function setVolume(v: number): void {
    const vol = Math.max(0, Math.min(100, Math.round(v)));
    markLocalEdit("volume");
    setPlayer((p) => (p.volume === vol ? p : { ...p, volume: vol }));
    invokeVolume(vol);
  }

  function toggleShuffle(): void {
    const on = !player().shuffle;
    markLocalEdit("shuffle");
    setPlayer((p) => ({ ...p, shuffle: on }));
    void invoke("set_shuffle", { on });
  }

  const REPEAT_NEXT: Record<string, string> = { off: "all", all: "one", one: "off" };

  function cycleRepeat(): void {
    const next = REPEAT_NEXT[player().repeat] ?? "off";
    markLocalEdit("repeat");
    setPlayer((p) => ({ ...p, repeat: next }));
    void invoke("set_repeat", { mode: next });
  }

  const SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

  function cycleSpeed(): void {
    const idx = SPEEDS.findIndex((s) => Math.abs(s - player().speed) < 0.001);
    const next = SPEEDS[(idx + 1) % SPEEDS.length]!;
    markLocalEdit("speed");
    setPlayer((p) => ({ ...p, speed: next }));
    void invoke("set_speed", { speed: next });
  }

  return {
    player,
    isPlaying,
    position,
    duration,
    volume,
    shuffle,
    repeat,
    speed,
    currentTrack,
    currentId,
    highlightPlaying,
    startPlayerSync,
    playTrack,
    togglePlay,
    nextTrack,
    prevTrack,
    seekTo,
    setVolume,
    toggleShuffle,
    cycleRepeat,
    cycleSpeed,
  };
});

export const player = playerOwner.player;
export const isPlaying = playerOwner.isPlaying;
export const position = playerOwner.position;
export const duration = playerOwner.duration;
export const volume = playerOwner.volume;
export const shuffle = playerOwner.shuffle;
export const repeat = playerOwner.repeat;
export const speed = playerOwner.speed;
export const currentTrack = playerOwner.currentTrack;
export const currentId = playerOwner.currentId;
export const highlightPlaying = playerOwner.highlightPlaying;
export const startPlayerSync = playerOwner.startPlayerSync;
export const playTrack = playerOwner.playTrack;
export const togglePlay = playerOwner.togglePlay;
export const nextTrack = playerOwner.nextTrack;
export const prevTrack = playerOwner.prevTrack;
export const seekTo = playerOwner.seekTo;
export const setVolume = playerOwner.setVolume;
export const toggleShuffle = playerOwner.toggleShuffle;
export const cycleRepeat = playerOwner.cycleRepeat;
export const cycleSpeed = playerOwner.cycleSpeed;
