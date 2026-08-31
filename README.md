# Embertune

A Linux music player + playlist ripper. Paste a YouTube or Spotify track/playlist
URL, download it into your library, and play it back — all in one app.

Built with **Tauri 2** (Rust core, SolidJS + TypeScript webview UI). Download
engines are sidecar CLIs — **yt-dlp** and **spotdl** — and playback is handled
by **mpv** over its JSON IPC socket (no bundled decoders).

## Features

- Paste YouTube / Spotify links into the URL bar — tracks or playlists, one per line — each queues automatically and downloads one at a time
- Live per-download progress bars
- **Themes** — glass (transparent), flat dark, and light mode, switchable in Settings
- Browse library, play / pause / next / prev / seek, volume
- Add local files from disk
- One-click "Update engines" (upgrades yt-dlp + spotdl)

## Requirements

Debian/Ubuntu (deb install pulls these automatically):

- `yt-dlp`, `ffmpeg`, `mpv`, `nodejs`
- `spotdl` — **not** in Debian repos, install manually:

  ```sh
  python3 -m pip install --user --upgrade spotdl
  ```

  (The in-app "Update engines" button installs it too.)

## Spotify setup

Spotify downloads need free API credentials. Create an app at
<https://developer.spotify.com/dashboard>, then paste the Client ID and Client
Secret into **Settings → Spotify credentials** in the app. They are stored in
`~/.local/share/embertune/settings.json` and passed to spotdl as env vars.

YouTube downloads work out of the box (needs `nodejs` for yt-dlp's JS challenge
solving, plus network access to GitHub for the ejs challenge-solver script).

## Build from source

```sh
npm install
npm run tauri build
```

Artifact: `src-tauri/target/release/bundle/deb/Embertune_0.1.0_amd64.deb`

Dev loop: `npm run tauri dev`

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
- See `PLAN.md` for architecture and known gotchas.
