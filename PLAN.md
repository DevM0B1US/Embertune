# Embertune — Plan

> **Historical document** (audit D4): this was the original build plan. The
> architecture has since evolved — the frontend was converted from vanilla
> JS to SolidJS + TypeScript with five domain stores (`src/lib/state/`),
> the `state.ts` god-module no longer exists, playback drives mpv over its
> JSON IPC socket (never libmpv), covers are served over the `art://`
> protocol, and the queue is handed to mpv with a single `loadlist` call.
> The milestones below are all shipped; keep this file as background only.

A Linux music player + playlist ripper. Tauri 2 (Rust core, webview UI) with
yt-dlp and spotdl as bundled sidecar engines, libmpv for playback.

## Goals (MVP)

1. Paste a YouTube / Spotify track or playlist URL -> downloads into library.
2. Live per-download progress in the UI (yt-dlp JSON progress lines -> Tauri events).
3. Browse downloaded library, play/pause/next/prev/seek.
4. Add local files from disk.
5. Update engines (yt-dlp -U, spotdl self-update) — one-click.

## Stack

- **App shell:** Tauri 2 (Rust backend, system webview frontend)
- **Frontend:** SolidJS + Vite + TypeScript (fine-grained reactivity, virtualized library list)
- **Download engines:** yt-dlp, spotdl — spawned as managed subprocesses,
  progress parsed from stdout/stderr, forwarded to UI as events
- **Playback:** mpv spawned with `--input-ipc-server` (JSON IPC socket), driven
  by Rust over JSON-RPC — handles m4a/opus/flac/etc. that rodio/symphonia can't
- **Storage:** rusqlite (bundled SQLite) at
  `~/.local/share/embertune/embertune.db`, music at
  `~/.local/share/embertune/library/music/`

## Architecture

```
┌─ Webview UI ───────────────────────────────────────┐
│  add-URL bar · queue list · progress bars ·        │
│  library grid · transport controls                 │
└───────────────┬────────────────────────────────────┘
                │ invoke + events
┌───────────────▼────────────────────────────────────┐
│  Rust core (lib.rs)                               │
│  · downloader: tokio tasks spawning yt-dlp/spotdl │
│  · player: libmpv handle + playback queue         │
│  · db: rusqlite library                           │
└───────────────────────────────────────────────────┘
```

### Modules (src-tauri/src/)
- `lib.rs` — Tauri app, state, command registration, lyrics, art protocol
- `downloader/` — DownloadManager: spawn, kill, progress parse, events
- `player.rs` — Player: mpv JSON IPC, queue (single `loadlist` call), transport
- `db.rs` — SQLite init, track CRUD
- `settings.rs` — atomic JSON settings store (0o600)
- `art.rs` — ffmpeg cover extraction, FNV-1a cache keys
- `util.rs` — shared helpers (audio extensions, title split, unix time)

## Schema

```sql
CREATE TABLE tracks (
  id          INTEGER PRIMARY KEY,
  title       TEXT NOT NULL,
  artist      TEXT DEFAULT '',
  album       TEXT DEFAULT '',
  duration    INTEGER DEFAULT 0,
  path        TEXT NOT NULL UNIQUE,
  source_url  TEXT DEFAULT '',
  source      TEXT DEFAULT '',       -- youtube | spotify | local
  cover       TEXT DEFAULT '',
  added_at    INTEGER NOT NULL
);
```

## Download behavior

- **YouTube:** `yt-dlp --newline --ignore-errors --js-runtimes <node|deno|bun>
  --remote-components ejs:github --extractor-args youtube:player_client=web_embedded
  --progress-template 'download:%(progress.downloaded_bytes)s/%(progress.total_bytes)s|%(info.title)s'
  --print 'after_move:FILEPATH:%(filepath)s' -f bestaudio/best` into
  `library/music/`. Files kept as-is (opus/m4a) — mpv plays them natively.
- **Spotify:** `spotdl <url> --output ...` (best-effort progress from stderr;
  completion-scanned: any new files added to library).
- Queue is a Vec of jobs; cancel kills the child process.
- `update_engines()`: `yt-dlp -U` + `pip install -U spotdl`.

## Milestones

- [x] Plan + environment (Rust, webkit2gtk, mpv, ffmpeg present)
- [x] Scaffold Tauri 2 app
- [x] DB module
- [x] Download manager
- [x] Player
- [x] Command wiring + state
- [x] Frontend UI
- [x] Build, verify, README

## Known gotchas

- Tauri Linux needs webkit2gtk-4.1 + build deps (installing).
- Debian's libmpv speaks client API 2.5; the `libmpv` crate hard-codes API 1 →
  `VersionMismatch`. **Embertune drives mpv over its JSON IPC socket instead**
  (`mpv --idle=yes --input-ipc-server=~/.local/share/embertune/mpv.sock`,
  JSON-RPC with `command_id`, single mutex-guarded connection).
- yt-dlp/spotdl are Python CLIs -> run as sidecars, don't embed.
- spotdl needs Spotify API creds (config file, prompted on first run).
- yt-dlp 2026 needs a JS runtime + EJS challenge solver for YouTube, and the
  default clients 403 on many IPs. Embertune passes `--js-runtimes <node|deno|bun>`
  (auto-detected), `--remote-components ejs:github`, and
  `--extractor-args youtube:player_client=web_embedded`. `nodejs` is a deb
  dependency. Debian's apt yt-dlp is too old — the "Update engines" button
  upgrades the pip one (`~/.local/bin/yt-dlp`, self-updates via `-U`).
- `--print FILEPATH:` alone returns `NA`; must be `--print after_move:FILEPATH:`.