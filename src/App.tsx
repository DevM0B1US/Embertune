import { invoke } from "@tauri-apps/api/core";
import { onCleanup, onMount } from "solid-js";
import Topbar from "./components/Topbar";
import LibraryView from "./components/LibraryView";
import MetaModal from "./components/MetaModal";
import SettingsModal from "./components/SettingsModal";
import Player from "./components/Player";
import LyricsPanel from "./components/LyricsPanel";
import PromptDialog from "./components/PromptDialog";
import Toast from "./components/Toast";
import { initDownloads } from "./lib/state/downloads";
import { initLibraryEvents, refreshLibrary } from "./lib/state/library";
import { initSettings } from "./lib/state/settings";
import { startPlayerSync } from "./lib/state/player";
import {
  closeMeta,
  closeSettings,
  focusSearch,
  lyricsFs,
  lyricsOpen,
  metaOpen,
  setLyricsFs,
  setLyricsOpen,
  settingsOpen,
} from "./lib/state/ui";
import { player, seekTo, setVolume, togglePlay } from "./lib/state/player";
import { sndClick } from "./lib/sounds";

export default function App() {
  onMount(() => {
    // ── store bootstrap (each returns a cleanup) ─────────────────────
    const cleanups = [initSettings(), initLibraryEvents(), initDownloads(), startPlayerSync()];
    onCleanup(() => cleanups.forEach((dispose) => dispose()));

    // ── global listeners ─────────────────────────────────────────────
    const ctxMenu = (e: MouseEvent) => e.preventDefault();
    document.addEventListener("contextmenu", ctxMenu);
    onCleanup(() => document.removeEventListener("contextmenu", ctxMenu));

    // click sound on interactive elements
    const clickSound = (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>("button, .pill");
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
    const closeLyricsShortcut = () => {
      setLyricsFs(false);
      if (shortcutOpenedLyrics) setLyricsOpen(false);
      shortcutOpenedLyrics = false;
    };
    const keyFs = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing =
        !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (e.key === "Escape" && lyricsFs()) {
        closeLyricsShortcut();
        return;
      }
      if (typing || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === "f" || e.key === "F") {
        if (!lyricsFs()) {
          shortcutOpenedLyrics = !lyricsOpen();
          if (shortcutOpenedLyrics) setLyricsOpen(true);
          setLyricsFs(true);
        } else {
          closeLyricsShortcut();
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
      switch (e.key) {
        case " ":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          seekTo(player().position - 5);
          break;
        case "ArrowRight":
          e.preventDefault();
          seekTo(player().position + 5);
          break;
        case "ArrowUp":
          e.preventDefault();
          setVolume((player().volume || 0) + 5);
          break;
        case "ArrowDown":
          e.preventDefault();
          setVolume((player().volume || 0) - 5);
          break;
        case "n":
        case "N":
          invoke("player_next");
          break;
        case "p":
        case "P":
          invoke("player_prev");
          break;
        case "/":
          e.preventDefault();
          focusSearch();
          break;
      }
    };
    document.addEventListener("keydown", keyShortcuts);
    onCleanup(() => document.removeEventListener("keydown", keyShortcuts));

    // initial library fetch
    void refreshLibrary();
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
