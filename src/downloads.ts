import { invoke } from "@tauri-apps/api/core";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import {
  $,
  val,
  setVal,
  esc,
  refreshIcons,
  toast,
  downloads,
  playlistGroups,
  dlRate,
} from "./lib";
import { renderLibrary, refreshLibrary } from "./library";
import { openPlaylist } from "./playlists";
import type { JobView, PlaylistGroup, PlaylistTrackRow } from "./lib";

// --- add url ---
function dlPercent(j: JobView): string {
  if (j.percent < 0) return "…";
  return `${Math.round(j.percent)}%`;
}

function fmtSpeed(bps: number): string {
  if (bps >= 1024 * 1024) return `${(bps / 1024 / 1024).toFixed(2)} MB/s`;
  if (bps >= 1024) return `${Math.round(bps / 1024)} KB/s`;
  return `${Math.round(bps)} B/s`;
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function speedFor(id: number, downloaded: number, status: string): string {
  if (status !== "downloading" || downloaded <= 0) return "";
  const now = performance.now();
  const prev = dlRate.get(id);
  let rate: number;
  if (prev && now > prev.t) {
    const dt = (now - prev.t) / 1000;
    const inst = dt > 0 ? (downloaded - prev.bytes) / dt : 0;
    rate = prev.rate > 0 ? prev.rate * 0.7 + inst * 0.3 : inst;
  } else {
    rate = 0;
  }
  dlRate.set(id, { t: now, bytes: downloaded, rate });
  return rate > 0 ? fmtSpeed(rate) : "";
}

function trackSpeed(j: JobView): string {
  return speedFor(j.id, j.downloaded, j.status);
}

// A playlist track row's meta line. Percent comes from the group's overall
// done/total when the whole playlist is one fallback job, otherwise from the
// track's own progress; speed and bytes are real disk-write measurements.
function dlRowMeta(g: PlaylistGroup, t: PlaylistTrackRow): string {
  const bits: string[] = [];
  if (g.fallback && g.total > 0) {
    bits.push(`${Math.min(100, Math.round((g.done / g.total) * 100))}%`);
  } else if (t.percent >= 0) {
    bits.push(`${Math.round(t.percent)}%`);
  }
  const sp = speedFor(t.id, t.downloaded ?? 0, t.status);
  if (sp) bits.push(sp);
  if ((t.downloaded ?? 0) > 0) bits.push(fmtBytes(t.downloaded!));
  return bits.length ? bits.join(" · ") : "…";
}

function dlStatusText(j: JobView): string {
  switch (j.status) {
    case "queued":
      return "Resolving…";
    case "downloading":
      return "Downloading";
    case "completed":
      return "Done";
    case "cancelled":
      return "Cancelled";
    case "error":
      return `Error: ${j.error || "unknown"}`;
    default:
      return j.status;
  }
}

export function renderDownloads(): void {
  const singles = [...downloads.values()];
  const groups = [...playlistGroups.values()];
  const panel = $("#downloads-panel");
  panel.classList.toggle("hidden", singles.length === 0 && groups.length === 0);
  const list = $("#dl-list");
  list.innerHTML = "";
  for (const g of groups) list.appendChild(buildGroupCard(g));
  for (const j of singles) list.appendChild(buildSingleRow(j));
  refreshIcons();
}

function buildSingleRow(j: JobView): HTMLLIElement {
  const active = j.status === "queued" || j.status === "downloading";
  const pct = j.percent < 0 ? 0 : Math.round(j.percent);
  const sp = j.status === "downloading" ? trackSpeed(j) : "";
  const bytes = j.downloaded > 0 ? fmtBytes(j.downloaded) : "";
  const isUrl = /^https?:\/\//.test(j.title);
  let sub: string;
  if (j.skipped) {
    sub = "Skipped — already in library";
  } else {
    const bits: string[] = [dlStatusText(j)];
    if (sp) bits.push(sp);
    if (bytes) bits.push(bytes);
    if (j.percent >= 0) bits.push(dlPercent(j));
    if (isUrl && j.status === "queued") bits.push("· pending");
    sub = bits.join(" · ");
  }
  const li = document.createElement("li");
  li.className = "track dl-row";
  li.innerHTML = `
    <div class="track-meta">
      <div class="track-title">${active ? '<span class="spinner"></span>' : ""}${esc(j.title || "Resolving…")}</div>
      <div class="track-sub">${esc(sub)}</div>
    </div>
    <div class="dl-progress"><div class="dl-fill" style="width:${pct}%"></div></div>
  `;
  return li;
}

function buildGroupCard(g: PlaylistGroup): HTMLLIElement {
  const total = g.total > 0 ? g.total : Math.max(g.tracks.size, 1);
  const done = Math.min(g.done, total);
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const label =
    g.finished && total > 0 && done >= total
      ? "Done"
      : g.finished && g.failed === total
        ? "Failed"
        : `${done}/${total}`;
  const skipBadge = g.skipped > 0
    ? `<span class="pl-group-skipped" title="Already in library — skipped">${g.skipped} skipped</span>`
    : "";
  const li = document.createElement("li");
  li.className = "pl-group";
  li.innerHTML = `
    <div class="pl-group-head">
      <span class="pl-tag">Playlist</span>
      <span class="pl-group-name">${esc(g.name)}</span>
      <span class="pl-group-count">${esc(label)}${skipBadge}</span>
    </div>
  `;
  const bar = document.createElement("div");
  bar.className = "pl-bar";
  bar.innerHTML = `<div class="dl-progress pl-progress"><div class="dl-fill" style="width:${pct}%"></div></div>`;
  if (!g.finished) {
    const cancel = document.createElement("button");
    cancel.className = "btn";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => {
      void invoke("cancel_download", { id: g.id });
      toast("Cancelling playlist…");
    });
    bar.appendChild(cancel);
  }
  li.appendChild(bar);
  const tracksUl = document.createElement("ul");
  tracksUl.className = "pl-tracks";
  for (const t of g.tracks.values()) {
    const row = document.createElement("li");
    row.className = `pl-track ${t.status}${t.skipped ? " skipped" : ""}`;
    const icon =
      t.skipped
        ? "↷"
        : t.status === "completed"
          ? "✓"
          : t.status === "error"
            ? "!"
            : t.status === "cancelled"
              ? "✕"
              : "";
    const sub =
      t.status === "downloading"
        ? dlRowMeta(g, t)
        : t.status === "queued"
          ? "queued"
          : t.status === "completed"
            ? t.skipped
              ? "skipped"
              : "done"
            : "";
    row.innerHTML = `
      <span class="pl-status">${t.status === "downloading" ? '<span class="spinner"></span>' : `<span class="pl-ic">${icon}</span>`}</span>
      <span class="pl-title">${esc(t.title)}</span>
      <span class="pl-sub">${esc(sub)}</span>
    `;
    tracksUl.appendChild(row);
  }
  li.appendChild(tracksUl);
  if (g.finished) {
    const actions = document.createElement("div");
    actions.className = "pl-actions";
    if (g.db_playlist !== null) {
      const open = document.createElement("button");
      open.className = "btn primary";
      open.textContent = "Open";
      open.addEventListener("click", () => {
        void openPlaylist({ id: g.db_playlist!, name: g.name, created_at: 0, track_count: total });
      });
      actions.appendChild(open);
    }
    const dismiss = document.createElement("button");
    dismiss.className = "btn";
    dismiss.textContent = "Dismiss";
    dismiss.addEventListener("click", () => {
      void invoke("clear_downloads");
      playlistGroups.delete(g.id);
      renderDownloads();
    });
    actions.appendChild(dismiss);
    li.appendChild(actions);
  }
  return li;
}

// --- playlist downloads ---
// A playlist pasted into the URL bar is resolved into its individual tracks.
// Its own job acts as a persistent group header so the user always sees what's
// happening: playlist name, done/total, a progress bar, and every track's
// live status — until the whole thing finishes (then Dismiss clears it).

export function updateGroupHeader(j: JobView): void {
  let g = playlistGroups.get(j.id);
  if (!g) {
    g = {
      id: j.id,
      name: "Playlist",
      kind: j.kind,
      total: 0,
      done: 0,
      failed: 0,
      skipped: 0,
      finished: false,
      db_playlist: null,
      fallback: false,
      tracks: new Map(),
    };
    playlistGroups.set(j.id, g);
  }
  if (j.status === "completed") {
    g.name = j.group_name || g.name;
  }
  if (j.group_total > 0) g.total = j.group_total;
  if (j.group_done > 0) g.done = j.group_done;
  if (j.group_skipped > 0) g.skipped = j.group_skipped;
  if (j.status === "error") {
    g.finished = true;
  }
  if (g.total > 0 && g.done >= g.total) g.finished = true;
  if (j.db_playlist !== null && j.db_playlist !== undefined) {
    g.db_playlist = j.db_playlist;
  }
  renderDownloads();
}

export function updateGroupTrack(j: JobView): void {
  const gid = j.group_id;
  if (gid === null || gid === undefined) return;
  let g = playlistGroups.get(gid);
  if (!g) {
    g = {
      id: gid,
      name: "Playlist",
      kind: "youtube",
      total: 0,
      done: 0,
      failed: 0,
      skipped: 0,
      finished: false,
      db_playlist: null,
      fallback: false,
      tracks: new Map(),
    };
    playlistGroups.set(gid, g);
  }
  let t = g.tracks.get(j.id);
  if (!t) {
    t = { id: j.id, title: j.title || "…", status: j.status, percent: j.percent, downloaded: j.downloaded };
    g.tracks.set(j.id, t);
  }
  t.status = j.status;
  if (j.percent >= 0) t.percent = j.percent;
  if (j.downloaded > 0) t.downloaded = j.downloaded;
  if (j.title) t.title = j.title;
  t.skipped = !!j.skipped;

  // A child whose URL is itself a playlist means the whole playlist is being
  // downloaded as ONE job (enumeration failed — e.g. missing Spotify creds).
  // The playlist header is driven by spotdl/yt-dlp's "X of Y" counter instead
  // of per-track completion; the single row shows the current song live.
  const isFallback = detectPlaylist(j.url) !== null;
  if (isFallback) g.fallback = true;
  if (g.fallback) {
    if (j.status === "completed" && g.total > 0) {
      g.done = g.total;
      g.finished = true;
    } else if (j.status === "error" || j.status === "cancelled") {
      g.finished = true;
    }
    renderDownloads();
    return;
  }

  let done = 0;
  let failed = 0;
  for (const x of g.tracks.values()) {
    if (x.status === "completed") done++;
    else if (x.status === "error" || x.status === "cancelled") failed++;
  }
  g.done = done;
  g.failed = failed;
  if (g.total > 0 && done + failed >= g.total) g.finished = true;
  renderDownloads();
}

function detectPlaylist(url: string): "youtube" | "spotify" | null {
  const u = url.trim().toLowerCase();
  if (
    (u.includes("youtube.com") || u.includes("youtu.be") || u.includes("music.youtube.com")) &&
    (u.includes("/playlist") || u.includes("list="))
  ) {
    return "youtube";
  }
  if (u.includes("open.spotify.com/playlist/") || u.startsWith("spotify:playlist:")) {
    return "spotify";
  }
  return null;
}

async function queueUrl(url: string): Promise<void> {
  const id = await invoke<number>("add_download", { url });
  const pl = detectPlaylist(url);
  // playlist jobs render as a group card in the downloads panel, never as a
  // single row — otherwise the same download shows up twice
  if (pl) return;
  downloads.set(id, {
    id,
    url,
    kind: pl ?? (url.includes("spotify") || url.startsWith("spotify:") ? "spotify" : "youtube"),
    status: "queued",
    title: url,
    percent: -1,
    downloaded: 0,
    total: 0,
    error: null,
    skipped: false,
    group_id: null,
    group_name: "",
    group_total: 0,
    group_done: 0,
    group_skipped: 0,
    db_playlist: null,
  });
  renderDownloads();
}

function autoGrow(el: HTMLTextAreaElement): void {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
}

function addUrls(): void {
  const raw = val("#url-input").trim();
  if (!raw) return;
  const urls = raw
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!urls.length) return;
  for (const u of urls) void queueUrl(u);
  setVal("#url-input", "");
  autoGrow($("#url-input"));
  renderLibrary();
  toast(
    urls.length === 1
      ? "Added to queue — downloading…"
      : `Queued ${urls.length} downloads — one by one`,
  );
}

const urlInput = $("#url-input") as HTMLTextAreaElement;
urlInput.addEventListener("input", () => autoGrow(urlInput));
urlInput.addEventListener("keydown", (e) => {
  // Shift+Enter lets you add another line manually; plain Enter downloads
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    addUrls();
  }
});
$("#add-btn").addEventListener("click", () => addUrls());

// --- local files ---
$("#local-btn").addEventListener("click", async () => {
  const picked = await dialogOpen({
    multiple: true,
    filters: [{ name: "Audio", extensions: ["mp3", "m4a", "opus", "ogg", "flac", "wav", "aac", "webm"] }],
  });
  if (!picked) return;
  const list = Array.isArray(picked) ? picked : [picked];
  const res = await Promise.all(
    list.map((p) => invoke<boolean>("add_local_file", { path: p })),
  );
  const added = res.filter(Boolean).length;
  toast(added ? `Added ${added} file${added === 1 ? "" : "s"}` : "Files already in library");
  await refreshLibrary();
});

