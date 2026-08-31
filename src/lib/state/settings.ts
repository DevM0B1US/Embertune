import { invoke } from "@tauri-apps/api/core";
import { createEffect, createRoot, createSignal } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import type { AppSettings } from "../types";

// ═══════════════════════════════════════════════════════════════════
//  Settings store — app settings, download dir, engine update log.
//  The theme is applied at the document root reactively.
// ═══════════════════════════════════════════════════════════════════

const settingsOwner = createRoot(() => {
  const [settings, setSettings] = createSignal<AppSettings>({
    spotify_client_id: null,
    has_spotify_creds: false,
    quality: "best",
    theme: "glass",
    window_controls: false,
  });
  const [dlDir, setDlDir] = createSignal("");
  const [engineLog, setEngineLog] = createSignal<string | null>(null);

  // theme applies at the root wherever the setting changes
  createEffect(() => {
    document.documentElement.dataset.theme = settings().theme || "glass";
  });

  function applyTheme(theme: string): void {
    // audit Q3: the direct DOM write here duplicated the reactive effect
    // below (which fires on the same tick) — the effect is the single writer
    void invoke("set_theme", { theme });
    setSettings((s) => ({ ...s, theme }));
  }

  /** Fetch persisted settings + subscribe to engine events. Returns cleanup. */
  function initSettings(): () => void {
    const unsubs: Array<() => void> = [];
    void listen("engines-updated", (e) => setEngineLog(String(e.payload))).then((u) =>
      unsubs.push(u)
    );
    void (async () => {
      try {
        setSettings(await invoke<AppSettings>("get_settings"));
      } catch {
        /* settings backend missing */
      }
      try {
        setDlDir(await invoke<string>("get_download_dir"));
      } catch {
        /* settings backend missing */
      }
    })();
    return () => unsubs.forEach((u) => u());
  }

  return { settings, setSettings, dlDir, setDlDir, engineLog, setEngineLog, applyTheme, initSettings };
});

export const settings = settingsOwner.settings;
export const setSettings = settingsOwner.setSettings;
export const dlDir = settingsOwner.dlDir;
export const setDlDir = settingsOwner.setDlDir;
export const engineLog = settingsOwner.engineLog;
export const setEngineLog = settingsOwner.setEngineLog;
export const applyTheme = settingsOwner.applyTheme;
export const initSettings = settingsOwner.initSettings;
