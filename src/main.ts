import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  $,
  refreshIcons,
  sndClick,
  sndOpen,
  sndClose,
  sndDone,
  toast,
  downloads,
  state,
  setLyricsFs,
  instantClose,
  closeMenus,
} from "./lib";
import { renderLibrary, refreshLibrary } from "./library";
import { refreshPlaylists, renderPlaylistsMenu } from "./playlists";
import { renderDownloads, updateGroupHeader, updateGroupTrack } from "./downloads";
import { renderQueue, loadLyrics, updateLyrics, pollPlayer, loadSettings } from "./player";
import { initEqualizer } from "./equalizer";
import type { JobView } from "./lib";

// --- drawers / menus ---
$("#btn-queue").addEventListener("click", () => {
  const p = $("#queue-panel");
  const open = p.classList.toggle("open");
  if (open) sndOpen();
  else sndClose();
  $("#btn-queue").classList.toggle("active", open);
  if (open) {
    instantClose($("#lyrics-panel"), $("#btn-lyrics"));
    instantClose($("#eq-panel"), $("#btn-eq"));
    $("#playlists-menu").classList.add("hidden");
    renderQueue();
  }
});
$("#btn-queue-close").addEventListener("click", () => {
  sndClose();
  $("#queue-panel").classList.remove("open");
  $("#btn-queue").classList.remove("active");
});

$("#btn-lyrics").addEventListener("click", () => {
  const p = $("#lyrics-panel");
  const open = p.classList.toggle("open");
  if (open) sndOpen();
  else sndClose();
  $("#btn-lyrics").classList.toggle("active", open);
  if (open) {
    instantClose($("#queue-panel"), $("#btn-queue"));
    instantClose($("#eq-panel"), $("#btn-eq"));
    $("#playlists-menu").classList.add("hidden");
    loadLyrics();
  }
});
$("#btn-lyrics-close").addEventListener("click", () => {
  setLyricsFs(false);
  sndClose();
  $("#lyrics-panel").classList.remove("open");
  $("#btn-lyrics").classList.remove("active");
});

$("#btn-lyrics-fs").addEventListener("click", () => {
  const fs = !$("#lyrics-panel").classList.contains("fs");
  setLyricsFs(fs);
  if (fs) {
    $("#queue-panel").classList.remove("open");
    $("#btn-queue").classList.remove("active");
  } else {
    updateLyrics();
  }
});
let shortcutOpenedLyrics = false;
document.addEventListener("keydown", (e) => {
  const el = e.target as HTMLElement | null;
  const typing =
    !!el &&
    (el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      (el as HTMLElement).isContentEditable);
  if (e.key === "Escape" && $("#lyrics-panel").classList.contains("fs")) {
    setLyricsFs(false);
    if (shortcutOpenedLyrics) {
      $("#lyrics-panel").classList.remove("open");
      $("#btn-lyrics").classList.remove("active");
    }
    shortcutOpenedLyrics = false;
    return;
  }
  if (typing || e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === "f" || e.key === "F") {
    const p = $("#lyrics-panel");
    const fs = !p.classList.contains("fs");
    if (fs) {
      shortcutOpenedLyrics = !p.classList.contains("open");
      if (shortcutOpenedLyrics) {
        p.classList.add("open");
        $("#btn-lyrics").classList.add("active");
        instantClose($("#queue-panel"), $("#btn-queue"));
        $("#playlists-menu").classList.add("hidden");
        loadLyrics();
      }
      setLyricsFs(true);
    } else {
      setLyricsFs(false);
      updateLyrics();
      if (shortcutOpenedLyrics) {
        p.classList.remove("open");
        $("#btn-lyrics").classList.remove("active");
      }
      shortcutOpenedLyrics = false;
    }
  }
});

$("#btn-playlists").addEventListener("click", (e) => {
  e.stopPropagation();
  const m = $("#playlists-menu");
  const open = m.classList.toggle("hidden");
  if (open) return;
  renderPlaylistsMenu();
});

document.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (
    t.closest(
      "#queue-panel, #btn-queue, #lyrics-panel, #btn-lyrics, #eq-panel, #btn-eq, #playlists-menu, #btn-playlists"
    )
  ) {
    return;
  }
  closeMenus();
});

// --- events ---
void listen("download-progress", (e) => {
  const j = e.payload as JobView;
  // playlist group headers and their tracks render inside the same downloads
  // panel; the header is the group card, children feed its track list.
  if (j.kind === "playlist") {
    if (j.status === "completed") sndDone();
    // a playlist job is a group card, never a single row
    downloads.delete(j.id);
    updateGroupHeader(j);
    return;
  }
  if (j.group_id) {
    updateGroupTrack(j);
    return;
  }
  if (j.status === "completed" || j.status === "error" || j.status === "cancelled") {
    if (j.status === "completed") sndDone();
    if (j.status === "error") toast(`Download failed: ${j.error || "unknown"}`);
    downloads.delete(j.id);
  } else {
    downloads.set(j.id, j);
  }
  // only the small downloads panel changes — never rebuild the whole library
  renderDownloads();
});

void listen("library-changed", () => {
  void refreshLibrary();
  void refreshPlaylists();
});

void listen("engines-updated", (e) => {
  $("#engine-log").textContent = String(e.payload);
});

// --- init ---
// no right-click context menu in the webview
document.addEventListener("contextmenu", (e) => e.preventDefault());

// subtle tick on every button press; panel toggles layer their own pop on top
document.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>("button, .pill, .menu-item");
  if (!btn) return;
  // range sliders and drag strips are not discrete buttons — stay silent
  if (btn.closest(".seek-wrap")) return;
  sndClick();
});

refreshIcons();
initEqualizer();
void refreshLibrary();
void refreshPlaylists();
void loadSettings();
void (async () => {
  try {
    const jobs = await invoke<JobView[]>("list_downloads");
    for (const j of jobs) {
      if (j.kind === "playlist") {
        downloads.delete(j.id);
        updateGroupHeader(j);
      } else if (j.group_id) updateGroupTrack(j);
      else downloads.set(j.id, j);
    }
    renderDownloads();
    renderLibrary();
  } catch {
    /* no downloads backend */
  }
})();
setInterval(() => void pollPlayer(), 500);
let lastQueueSig = "";
setInterval(() => {
  if ($("#queue-panel").classList.contains("open")) {
    const sig = `${state.queue.map((t) => t.id).join(",")}|${state.current ? state.current.id : ""}`;
    if (sig !== lastQueueSig) {
      lastQueueSig = sig;
      renderQueue();
    }
  }
}, 1000);
