import { createEffect, onCleanup, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Topbar from "./components/Topbar";
import LibraryView from "./components/LibraryView";
import MetaModal from "./components/MetaModal";
import SettingsModal from "./components/SettingsModal";
import Player from "./components/Player";
import LyricsPanel from "./components/LyricsPanel";
import PromptDialog from "./components/PromptDialog";
import Toast from "./components/Toast";
import {
  closeMeta,
  closeSettings,
  dlMap,
  ingestJob,
  lyricsFs,
  lyricsOpen,
  metaOpen,
  player,
  refreshLibrary,
  scheduleDlRender,
  setDlDir,
  setEngineLog,
  setLyricsFs,
  setLyricsOpen,
  setPlayHi,
  setPlayer,
  setSettings,
  settings,
  settingsOpen,
} from "./lib/state";
import { sndClick } from "./lib/sounds";
import { updateSleepBtn } from "./lib/sleep";
import type { AppSettings, JobView, PlayerState } from "./lib/types";

export default function App() {
  // theme applies at the root wherever the setting changes
  createEffect(() => {
    document.documentElement.dataset.theme = settings().theme || "glass";
  });

  onMount(() => {
    const unsubs: Array<() => void> = [];
    onCleanup(() => unsubs.forEach((u) => u()));

    // ── global listeners ────────────────────────────────────────────
    const ctxMenu = (e: MouseEvent) => e.preventDefault();
    document.addEventListener("contextmenu", ctxMenu);
    onCleanup(() => document.removeEventListener("contextmenu", ctxMenu));

    // click sound on interactive elements
    const clickSound = (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>("button, .pill, .menu-item");
      if (!btn) return;
      if (btn.closest(".seek-wrap")) return;
      sndClick();
    };
    document.addEventListener("click", clickSound);
    onCleanup(() => document.removeEventListener("click", clickSound));

    // outside click closes the lyrics drawer
    const outsideClose = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("#lyrics-panel, #btn-lyrics")) return;
      setLyricsOpen(false);
    };
    document.addEventListener("click", outsideClose);
    onCleanup(() => document.removeEventListener("click", outsideClose));

    // keyboard: F toggles lyrics fullscreen (with the shortcut-opened flag)
    let shortcutOpenedLyrics = false;
    const keyFs = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing =
        !!el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable);
      if (e.key === "Escape" && lyricsFs()) {
        setLyricsFs(false);
        if (shortcutOpenedLyrics) setLyricsOpen(false);
        shortcutOpenedLyrics = false;
        return;
      }
      if (typing || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === "f" || e.key === "F") {
        const fs = !lyricsFs();
        if (fs) {
          shortcutOpenedLyrics = !lyricsOpen();
          if (shortcutOpenedLyrics) setLyricsOpen(true);
          setLyricsFs(true);
        } else {
          setLyricsFs(false);
          if (shortcutOpenedLyrics) setLyricsOpen(false);
          shortcutOpenedLyrics = false;
        }
      }
    };
    document.addEventListener("keydown", keyFs);
    onCleanup(() => document.removeEventListener("keydown", keyFs));

    // Escape closes whatever overlay is on top (lyrics-fs handled above)
    const keyEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (settingsOpen()) {
        closeSettings();
        return;
      }
      if (metaOpen()) closeMeta();
    };
    document.addEventListener("keydown", keyEscape);
    onCleanup(() => document.removeEventListener("keydown", keyEscape));

    // keyboard: transport shortcuts (skip when typing / control focused)
    const keyShortcuts = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (el.closest?.("button, [role='button'], a")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const p = player();
      switch (e.key) {
        case " ":
          e.preventDefault();
          void invoke("toggle_play");
          break;
        case "ArrowLeft":
          e.preventDefault();
          void invoke("player_seek", { secs: Math.max(0, p.position - 5) });
          break;
        case "ArrowRight":
          e.preventDefault();
          void invoke("player_seek", { secs: p.position + 5 });
          break;
        case "ArrowUp":
          e.preventDefault();
          void invoke("player_set_volume", { volume: Math.min(100, (p.volume || 0) + 5) });
          break;
        case "ArrowDown":
          e.preventDefault();
          void invoke("player_set_volume", { volume: Math.max(0, (p.volume || 0) - 5) });
          break;
        case "n":
        case "N":
          void invoke("player_next");
          break;
        case "p":
        case "P":
          void invoke("player_prev");
          break;
        case "/":
          e.preventDefault();
          (document.getElementById("search") as HTMLInputElement | null)?.focus();
          break;
      }
    };
    document.addEventListener("keydown", keyShortcuts);
    onCleanup(() => document.removeEventListener("keydown", keyShortcuts));

    // ── tauri events ────────────────────────────────────────────────
    void listen("download-progress", (e) => {
      ingestJob(e.payload as JobView);
    }).then((u) => unsubs.push(u));

    void listen("library-changed", () => {
      void refreshLibrary();
    }).then((u) => unsubs.push(u));

    void listen("engines-updated", (e) => {
      setEngineLog(String(e.payload));
    }).then((u) => unsubs.push(u));

    // ── init ────────────────────────────────────────────────────────
    void refreshLibrary();
    void (async () => {
      try {
        const s = await invoke<AppSettings>("get_settings");
        setSettings(s);
      } catch {
        /* settings backend missing */
      }
      try {
        setDlDir(await invoke<string>("get_download_dir"));
      } catch {
        /* settings backend missing */
      }
    })();
    void (async () => {
      try {
        const jobs = await invoke<JobView[]>("list_downloads");
        for (const j of jobs) dlMap.set(j.id, j);
        scheduleDlRender();
      } catch {
        /* no downloads backend */
      }
    })();

    // ── player poll — adaptive: 500ms playing, 900/1000ms otherwise ──
    let pollTimer: number | undefined;
    let lastHidden = 0;
    const pollPlayer = async (): Promise<void> => {
      const now = Date.now();
      if (document.hidden && now - lastHidden < 1000) return;
      if (document.hidden) lastHidden = now;
      let ps: PlayerState;
      try {
        ps = await invoke<PlayerState>("get_player_state");
      } catch {
        return;
      }
      setPlayer(ps);
      const curId = ps.current?.id ?? null;
      setPlayHi((prev) =>
        prev.id === curId && prev.playing === ps.playing ? prev : { id: curId, playing: ps.playing }
      );
      updateSleepBtn();
      // sync seek/volume sliders unless the user is on them
      const seek = document.getElementById("seek") as HTMLInputElement | null;
      if (seek && document.activeElement !== seek && ps.duration > 0) {
        seek.value = String(Math.min(1000, (ps.position / ps.duration) * 1000));
      }
      const vol = document.getElementById("volume") as HTMLInputElement | null;
      if (vol && document.activeElement !== vol) vol.value = String(ps.volume);
    };
    const schedulePoll = () => {
      const delay = document.hidden ? 1000 : player().playing ? 500 : 900;
      pollTimer = window.setTimeout(async () => {
        await pollPlayer();
        schedulePoll();
      }, delay);
    };
    schedulePoll();
    onCleanup(() => clearTimeout(pollTimer));
    const onVis = () => {
      if (!document.hidden) void pollPlayer();
    };
    document.addEventListener("visibilitychange", onVis);
    onCleanup(() => document.removeEventListener("visibilitychange", onVis));
  });

  return (
    <>
      <main id="main">
        <Topbar />
        <LibraryView />
        <MetaModal />
      </main>
      <SettingsModal />
      <Player />
      <LyricsPanel />
      <PromptDialog />
      <Toast />
    </>
  );
}
