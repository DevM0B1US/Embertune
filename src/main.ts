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
  closeMenus,
  closeSettings,
} from "./lib";
import { refreshLibrary } from "./library";
import { renderDownloads } from "./downloads";
import { loadLyrics, updateLyrics, pollPlayer, loadSettings } from "./player";
import type { JobView } from "./lib";

// --- drawers / menus ---
$("#btn-lyrics").addEventListener("click", () => {
  const p = $("#lyrics-panel");
  const open = p.classList.toggle("open");
  if (open) sndOpen();
  else sndClose();
  $("#btn-lyrics").classList.toggle("active", open);
  if (open) {
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
  if (!fs) {
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

document.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (t.closest("#lyrics-panel, #btn-lyrics")) {
    return;
  }
  closeMenus();
});

// Escape closes whatever overlay is on top (lyrics-fs has its own handler)
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if ($("#settings-overlay").classList.contains("open")) {
    closeSettings();
    return;
  }
  const meta = $("#meta-overlay");
  if (meta.classList.contains("open")) {
    meta.classList.remove("open");
    sndClose();
  }
});

// --- events ---
void listen("download-progress", (e) => {
  const j = e.payload as JobView;
  if (j.status === "completed" || j.status === "error" || j.status === "cancelled") {
    if (j.status === "completed") sndDone();
    if (j.status === "error") toast(`Download failed: ${j.error || "unknown"}`);
    downloads.delete(j.id);
  } else {
    downloads.set(j.id, j);
  }
  renderDownloads();
});

void listen("library-changed", () => {
  void refreshLibrary();
});

void listen("engines-updated", (e) => {
  const log = $("#engine-log");
  log.textContent = String(e.payload);
  log.classList.remove("hidden");
});

// --- init ---
document.addEventListener("contextmenu", (e) => e.preventDefault());

document.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>("button, .pill, .menu-item");
  if (!btn) return;
  if (btn.closest(".seek-wrap")) return;
  sndClick();
});

refreshIcons();
void refreshLibrary();
void loadSettings();
void (async () => {
  try {
    const jobs = await invoke<JobView[]>("list_downloads");
    for (const j of jobs) {
      downloads.set(j.id, j);
    }
    renderDownloads(); // refreshLibrary already rendered the list
  } catch {
    /* no downloads backend */
  }
})();
// adaptive poll: 500ms when playing, 1000ms when paused/hidden — saves IPC + wakeups
let pollTimer: number | undefined;
function schedulePoll() {
  const delay = document.hidden ? 1000 : state.playing ? 500 : 900;
  pollTimer = window.setTimeout(async () => {
    await pollPlayer();
    schedulePoll();
  }, delay);
}
schedulePoll();
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void pollPlayer();
});
