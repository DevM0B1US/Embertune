// ═══════════════════════════════════════════════════════════════════
//  DEV-ONLY browser harness — Tauri IPC mock.
//
//  Lets the UI run in a plain browser (`npm run dev` without the Rust
//  shell) so rendering, virtualization and scroll behavior can be
//  exercised with large libraries. Installed ONLY when:
//    · import.meta.env.DEV, and
//    · no real Tauri IPC exists (`__TAURI_INTERNALS__` absent)
//  In the packaged app this module is never imported.
//
//  Library size is tunable for load testing:  ?tracks=5000
// ═══════════════════════════════════════════════════════════════════

import type { JobView, PlayerState, RepeatMode, Track } from "../lib/types";

const ARTISTS = [
  "Ember Kings", "Nova Vale", "The Hollow Suns", "Cassette Ghosts", "Ivory Static",
  "Redline Choir", "Moth & Lantern", "Paper Aeroplanes", "Glass Harbour", "Violet Engine",
  "Low Tide Orchestra", "Neon Monks", "Harborlights", "The Vinyl Foxes", "Aurora Motel",
  "Copper Wires", "Midnight Postcards", "Silver Ferns", "Echo Parade", "Golden Hour Club",
];

const TITLES = [
  "Afterglow", "Paper Planes", "Static Bloom", "Northern Line", "Slow Gold",
  "Glasshouse", "Runaway Signal", "Undertow", "Cassette Heart", "Fever Dream",
  "Low Orbit", "Half Light", "Amber Routes", "Small Fires", "Night Bus",
  "Concrete Sea", "Soft Riot", "Wildflowers", "Ghost Writer", "Dead Calm",
];

function makeTracks(count: number): Track[] {
  const now = Date.now();
  const tracks: Track[] = [];
  for (let i = 0; i < count; i++) {
    const artist = ARTISTS[i % ARTISTS.length]!;
    const title = `${TITLES[i % TITLES.length]}${i >= TITLES.length ? ` ${Math.floor(i / TITLES.length) + 1}` : ""}`;
    tracks.push({
      id: i + 1,
      title,
      artist,
      album: `${artist} — Collection ${Math.floor(i / ARTISTS.length) + 1}`,
      duration: 95 + ((i * 137) % 245),
      path: `/mock/library/${i + 1}.m4a`,
      source_url: `https://youtube.com/watch?v=mock${i + 1}`,
      source: i % 3 === 0 ? "youtube" : i % 3 === 1 ? "spotify" : "local",
      added_at: now - i * 60000,
      favorite: i % 17 === 0,
    });
  }
  return tracks;
}

function artDataUri(track: Track): string {
  const hue = (track.id * 47) % 360;
  const letter = track.title.charAt(0).toUpperCase();
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72">` +
    `<rect width="72" height="72" fill="hsl(${hue},45%,30%)"/>` +
    `<circle cx="52" cy="20" r="26" fill="hsl(${hue},55%,45%)" opacity="0.55"/>` +
    `<text x="36" y="46" font-family="sans-serif" font-size="30" font-weight="700" ` +
    `fill="#fff" text-anchor="middle" opacity="0.9">${letter}</text></svg>`;
  return `data:image/svg+xml;base64,${btoa(String.fromCharCode(...new TextEncoder().encode(svg)))}`;
}

interface MockState {
  tracks: Track[];
  theme: string;
  player: {
    playing: boolean;
    basePos: number;
    startedAt: number;
    volume: number;
    shuffle: boolean;
    repeat: RepeatMode;
    speed: number;
    currentIndex: number;
  };
}

/** Strict optimistic kind — mirrors the backend (audit B9). */
function mockKindOf(url: string): "spotify" | "youtube" {
  return url.includes("open.spotify.com") || url.startsWith("spotify:") ? "spotify" : "youtube";
}

export function installTauriMock(): void {
  if ("__TAURI_INTERNALS__" in window) return;

  const params = new URLSearchParams(location.search);
  const trackCount = Math.max(1, Math.min(50000, Number(params.get("tracks") ?? 3000) || 3000));

  const state: MockState = {
    tracks: makeTracks(trackCount),
    theme: params.get("theme") ?? "glass",
    player: {
      playing: false,
      basePos: 0,
      startedAt: 0,
      volume: 80,
      shuffle: false,
      repeat: "off",
      speed: 1.0,
      currentIndex: -1,
    },
  };

  // ── event plumbing (mirrors @tauri-apps/api v2 event system) ──────
  const listeners = new Map<string, Set<string>>();
  let callbackSeq = 0;
  let eventSeq = 0;

  function emit(event: string, payload?: unknown): void {
    const handlers = listeners.get(event);
    if (!handlers) return;
    for (const id of handlers) {
      const fn = (window as unknown as Record<string, unknown>)[id];
      if (typeof fn === "function") (fn as (e: unknown) => void)({ event, id: ++eventSeq, payload });
    }
  }

  // ── download simulation ───────────────────────────────────────────
  const jobs = new Map<number, JobView>();
  let jobSeq = 0;

  function beginJob(id: number): void {
    const job = jobs.get(id);
    if (!job) return;
    window.setTimeout(() => {
      job.status = "downloading";
      job.title = `Mock track ${id} — ${decodeURIComponent(urlTitle(job.url))}`;
      job.total = 4_000_000 + Math.floor(Math.random() * 6_000_000);
      emit("download-progress", { ...job });
      const timer = window.setInterval(() => {
        const j = jobs.get(id);
        if (!j) {
          window.clearInterval(timer);
          return;
        }
        j.downloaded = Math.min(j.total, j.downloaded + 120_000 + Math.floor(Math.random() * 400_000));
        j.percent = (j.downloaded / j.total) * 100;
        if (j.downloaded >= j.total) {
          window.clearInterval(timer);
          j.status = "completed";
          j.percent = 100;
          emit("download-progress", { ...j });
          jobs.delete(id);
          // the ripper adds the finished track to the library
          const track = makeTracks(1)[0]!;
          track.id = (state.tracks[state.tracks.length - 1]?.id ?? 0) + 1;
          track.title = j.title;
          track.source = j.kind;
          state.tracks.unshift(track);
          window.setTimeout(() => emit("library-changed", track.id), 400);
          return;
        }
        emit("download-progress", { ...j });
      }, 250);
    }, 700);
  }

  function urlTitle(url: string): string {
    try {
      return new URL(url).pathname.replace(/^\//, "") || url;
    } catch {
      return url;
    }
  }

  // ── player simulation ─────────────────────────────────────────────
  function playerState(): PlayerState {
    const p = state.player;
    const current = p.currentIndex >= 0 ? state.tracks[p.currentIndex] : null;
    let position = p.basePos;
    if (p.playing && current) {
      position = p.basePos + ((Date.now() - p.startedAt) / 1000) * p.speed;
      if (position >= current.duration) {
        if (p.repeat === "one") {
          position %= current.duration;
          p.basePos = position;
          p.startedAt = Date.now();
        } else {
          advance(1);
          const c = state.tracks[p.currentIndex]!;
          return { ...snapshot(), position: 0, duration: c.duration, current: { ...c } };
        }
      }
    }
    return {
      ...snapshot(),
      position: Math.min(position, current?.duration ?? 0),
      duration: current?.duration ?? 0,
      current: current ? { ...current } : null,
    };
  }

  function snapshot() {
    const p = state.player;
    return {
      playing: p.playing,
      volume: p.volume,
      idle: p.currentIndex < 0,
      shuffle: p.shuffle,
      repeat: p.repeat,
      speed: p.speed,
    };
  }

  function advance(dir: 1 | -1): void {
    const p = state.player;
    const n = state.tracks.length;
    if (n === 0) {
      p.currentIndex = -1;
      return;
    }
    if (p.shuffle && n > 1) {
      let next = p.currentIndex;
      while (next === p.currentIndex) next = Math.floor(Math.random() * n);
      p.currentIndex = next;
    } else {
      p.currentIndex = (p.currentIndex + dir + n) % n;
    }
    p.basePos = 0;
    p.startedAt = Date.now();
  }

  // ── invoke dispatch ───────────────────────────────────────────────
  type Args = Record<string, unknown>;

  function handleInvoke(cmd: string, args: Args): Promise<unknown> {
    const p = state.player;
    switch (cmd) {
      // events
      case "plugin:event|listen": {
        const event = String(args.event);
        const handler = String(args.handler);
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(handler);
        return Promise.resolve(++eventSeq);
      }
      case "plugin:event|unlisten": {
        listeners.get(String(args.event))?.delete(String(args.handler));
        return Promise.resolve(null);
      }

      // library
      case "get_library":
        return Promise.resolve([...state.tracks]);
      case "remove_track": {
        const id = Number(args.id);
        state.tracks = state.tracks.filter((t) => t.id !== id);
        return Promise.resolve(true);
      }
      case "set_favorite": {
        const t = state.tracks.find((t) => t.id === Number(args.id));
        if (t) t.favorite = Boolean(args.favorite);
        return Promise.resolve(true);
      }
      case "get_art": {
        const t = state.tracks.find((t) => t.id === Number(args.trackId));
        return Promise.resolve(t ? artDataUri(t) : null);
      }
      case "get_track_meta":
        return Promise.resolve(null);
      case "update_track_meta": {
        const t = state.tracks.find((t) => t.id === Number(args.id));
        if (t) {
          t.title = String(args.title ?? t.title);
          t.artist = String(args.artist ?? t.artist);
          t.album = String(args.album ?? t.album);
        }
        return Promise.resolve(true);
      }
      case "get_lyrics":
        return Promise.resolve(null);
      case "add_local_file":
        return Promise.resolve(false);

      // player
      case "get_player_state":
        return Promise.resolve(playerState());
      case "play_track": {
        const idx = state.tracks.findIndex((t) => t.id === Number(args.id));
        if (idx >= 0) {
          p.currentIndex = idx;
          p.basePos = 0;
          p.startedAt = Date.now();
          p.playing = true;
        }
        return Promise.resolve(true);
      }
      case "toggle_play":
        if (p.playing) {
          p.basePos += ((Date.now() - p.startedAt) / 1000) * p.speed;
          p.playing = false;
        } else {
          p.startedAt = Date.now();
          p.playing = true;
        }
        return Promise.resolve(true);
      case "player_next":
        advance(1);
        return Promise.resolve(true);
      case "player_prev":
        advance(-1);
        return Promise.resolve(true);
      case "player_seek":
        p.basePos = Number(args.secs) || 0;
        p.startedAt = Date.now();
        return Promise.resolve(true);
      case "player_set_volume":
        p.volume = Number(args.volume) || 0;
        return Promise.resolve(true);
      case "set_shuffle":
        p.shuffle = Boolean(args.on);
        return Promise.resolve(true);
      case "set_repeat":
        p.repeat = String(args.mode) as RepeatMode;
        return Promise.resolve(true);
      case "set_speed":
        p.speed = Number(args.speed) || 1;
        return Promise.resolve(true);

      // downloads
      case "add_download": {
        const id = ++jobSeq;
        const url = String(args.url);
        jobs.set(id, {
          id,
          url,
          kind: mockKindOf(url),
          status: "queued",
          title: url,
          percent: -1,
          downloaded: 0,
          total: 0,
          error: null,
          skipped: false,
        });
        beginJob(id);
        return Promise.resolve(id);
      }
      case "list_downloads":
        return Promise.resolve([...jobs.values()]);

      // settings / misc
      case "get_settings":
        return Promise.resolve({
          spotify_client_id: null,
          has_spotify_creds: false,
          quality: "best",
          theme: state.theme,
          window_controls: true,
        });
      case "set_theme":
        state.theme = String(args.theme);
        return Promise.resolve(true);
      case "get_download_dir":
        return Promise.resolve("/home/mock/Music/Embertune");
      case "set_download_dir":
      case "set_download_quality":
      case "set_spotify_creds":
      case "set_window_controls":
      case "set_sleep_timer":
      case "update_engines":
      case "extract_art":
        return Promise.resolve(true);
      case "plugin:dialog|open":
        return Promise.resolve(null);

      default:
        console.warn(`[embertune mock] unhandled invoke: ${cmd}`, args);
        return Promise.resolve(null);
    }
  }

  const internals = {
    transformCallback(callback: (e: unknown) => void, once = false): string {
      const id = `__tauri_cb_${++callbackSeq}`;
      Object.defineProperty(window, id, {
        value: (e: unknown) => {
          if (once) Reflect.deleteProperty(window, id);
          callback(e);
        },
        writable: false,
        configurable: true,
      });
      return id;
    },
    invoke(cmd: string, args: Args = {}): Promise<unknown> {
      return handleInvoke(cmd, args);
    },
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    },
  };

  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: internals,
    writable: false,
    configurable: false,
  });

  console.info(
    `[embertune mock] browser harness active — ${state.tracks.length.toLocaleString()} tracks` +
      (trackCount !== 3000 ? "" : " (tune with ?tracks=N)")
  );
}
