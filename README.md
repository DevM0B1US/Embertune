<p align="center">
  <img src=".github/logo.svg" width="96" alt="Embertune logo" />
</p>

<h1 align="center">Embertune</h1>

<p align="center">
  A fast, local-first music player with a built-in YouTube / Spotify ripper.<br/>
  Built with <strong>Tauri 2</strong> — Rust core, SolidJS + TypeScript webview UI.
</p>

<p align="center">
  <a href="https://github.com/DevM0B1US/Embertune/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/DevM0B1US/Embertune/ci.yml?branch=main&label=CI" alt="CI status" /></a>
  <a href="COPYING"><img src="https://img.shields.io/badge/license-GPL--3.0-orange" alt="License: GPL v3" /></a>
  <img src="https://img.shields.io/badge/Tauri-2-blue" alt="Tauri 2" />
  <img src="https://img.shields.io/badge/platform-Linux%20%7C%20Windows-lightgrey" alt="Platform" />
</p>

---

Paste a YouTube or Spotify track/playlist URL, download it into your library,
and play it back — all in one app. Download engines are sidecar CLIs
(**yt-dlp** and **spotdl**); playback is handled by **mpv** over its JSON IPC
socket. Nothing is bundled, nothing phones home, your library stays on disk.

## Features

- **URL ripping** — paste YouTube / Spotify links into the URL bar (tracks or
  playlists, one per line); each queues automatically and downloads one at a
  time with live per-download progress bars
- **Fast virtualized library** — the list renders only visible rows, so a
  10,000-track library scrolls as smoothly as a 10-track one; keyboard
  navigation included (↑/↓/PgUp/PgDn/Home/End, Enter to play)
- **Time-synced lyrics** — `.lrc` support with auto-follow, fullscreen mode,
  and a 4-second follow-pause when you scroll ahead yourself
- **Local files** — add files from disk or just drag-and-drop them onto the
  window
- **Themes** — glass (transparent), flat dark, and light mode, switchable in
  Settings
- **Transport + shortcuts** — play/pause, seek, volume, shuffle, repeat,
  playback speed, sleep timer
- **One-click "Update engines"** — upgrades yt-dlp + spotdl in place

## Requirements

Debian/Ubuntu (the .deb install pulls these in automatically):

- `yt-dlp`, `ffmpeg`, `mpv`, `nodejs`
- `spotdl` — **not** in Debian repos, install manually:

  ```sh
  python3 -m pip install --user --upgrade spotdl
  ```

  (The in-app "Update engines" button installs it too.)

Other distros: same package names (`pacman`/`dnf` equivalents apply). Windows:
install yt-dlp, ffmpeg, mpv and Python on PATH.

## Spotify setup

Spotify downloads need free API credentials. Create an app at
<https://developer.spotify.com/dashboard>, then paste the Client ID and Client
Secret into **Settings → Spotify credentials** in the app. They are stored in
`~/.local/share/embertune/settings.json` and passed to spotdl as env vars.

YouTube downloads work out of the box (needs `nodejs` for yt-dlp's JS challenge
solving, plus network access to GitHub for the ejs challenge-solver script).

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `←` / `→` | Seek −5s / +5s |
| `↑` / `↓` | Volume ±5 |
| `N` / `P` | Next / previous track |
| `/` | Focus search |
| `F` | Lyrics fullscreen |
| `Esc` | Close overlay / leave lyrics fullscreen |

In the track list: `↑↓ PgUp PgDn Home End` move a selection, `Enter`/`Space`
plays it. `Tab` focus cycling is intentionally disabled.

## Build from source

```sh
npm install
npm run tauri dev      # dev loop with hot reload
npm run tauri build    # release installers
```

Linux contributors need the Tauri system dependencies first:

```sh
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev libssl-dev
```

CI runs the same checks locally do: `npm run typecheck`, `npm run lint`,
`npm run test`, and `cargo check`/`cargo test` in `src-tauri`.

## Data

- Music: `~/.local/share/embertune/music/`
- Database: `~/.local/share/embertune/embertune.db`
- Settings: `~/.local/share/embertune/settings.json`
- mpv IPC socket: `~/.local/share/embertune/mpv.sock`

## Notes

- The apt-provided `yt-dlp` is too old for current YouTube; "Update engines"
  upgrades the pip-installed one in `~/.local/bin/yt-dlp`.
- Downloads use `youtube:player_client=web_embedded` because YouTube 403s the
  default clients on many IPs.

## License

Copyright © 2026 Embertune contributors

This program is free software: you can redistribute it and/or modify it under
the terms of the **GNU General Public License** as published by the Free
Software Foundation, either version 3 of the License, or (at your option) any
later version. See [LICENSE](LICENSE) for the full license text.

This program is distributed in the hope that it will be useful, but WITHOUT
ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
FOR A PARTICULAR PURPOSE.
