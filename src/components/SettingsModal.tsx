import { invoke } from "@tauri-apps/api/core";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import { createEffect, createSignal, For, onCleanup, onMount } from "solid-js";
import { focusModal, trapModalFocus } from "../lib/modal";
import {
  closeSettings,
  settingsOpen,
} from "../lib/state/ui";
import { dlDir, setDlDir, engineLog, setEngineLog, applyTheme, setSettings, settings } from "../lib/state/settings";
import { Ico } from "../lib/icons";
import { Download, Music2, Palette, RefreshCw, Wrench, X } from "lucide";

const THEMES = ["glass", "dark", "light"];
const QUALITIES: Array<[string, string]> = [
  ["best", "Best (m4a)"],
  ["mp3_320", "320k"],
  ["mp3_192", "192k"],
];

export default function SettingsModal() {
  let overlay!: HTMLDivElement;
  let spotId!: HTMLInputElement;
  let spotSecret!: HTMLInputElement;
  const [updating, setUpdating] = createSignal(false);

  // keep the secret out of the DOM — placeholder only
  createEffect(() => {
    spotSecret.placeholder = settings().has_spotify_creds ? "••••••••" : "";
  });

  // focus management (audit U3): focus lands in the dialog when it opens,
  // and Tab cycles inside it instead of reaching the background UI
  createEffect(() => focusModal(settingsOpen(), overlay));
  onMount(() => onCleanup(trapModalFocus(overlay)));

  const applyQuality = (v: string): void => {
    void invoke("set_download_quality", { quality: v });
    setSettings((s) => ({ ...s, quality: v }));
  };

  const onOverlayClick = (e: MouseEvent): void => {
    if (e.target === overlay) closeSettings();
  };

  const updateEngines = (): void => {
    setEngineLog("Updating…");
    setUpdating(true);
    void invoke("update_engines").finally(() => setUpdating(false));
  };

  return (
    <div
      ref={overlay}
      id="settings-overlay"
      classList={{ open: settingsOpen() }}
      onClick={onOverlayClick}
    >
      <div class="settings-card settings-modal" role="dialog" aria-modal="true" aria-label="Settings">
        <div class="settings-head">
          <span class="section-label">Settings</span>
          <button id="btn-settings-close" class="tbtn" title="Close" onClick={() => closeSettings()}>
            <Ico node={X} size={15} />
          </button>
        </div>
        <div class="settings-body">
          <section class="set-group">
            <div class="set-title">
              <Ico node={Palette} size={13} /> Appearance
            </div>
            <div class="set-stack">
              <div class="set-block">
                <div class="set-sub">Theme</div>
                <p class="hint">Glass is translucent. Dark / Light are solid with no blur.</p>
                <div class="pill-row" id="theme-pills">
                  <For each={THEMES}>
                    {(t) => (
                      <button
                        class="pill"
                        data-theme={t}
                        classList={{ active: settings().theme === t }}
                        onClick={() => applyTheme(t)}
                      >
                        {t[0]!.toUpperCase() + t.slice(1)}
                      </button>
                    )}
                  </For>
                </div>
              </div>
              <div class="set-divider" />
              <div class="set-row">
                <div class="set-copy">
                  <div class="set-label">Window controls</div>
                  <p class="hint">Show minimize / maximize / close in title bar.</p>
                </div>
                <button
                  type="button"
                  class="tgl"
                  id="win-toggle"
                  role="switch"
                  aria-checked={settings().window_controls ? "true" : "false"}
                  onClick={() => {
                    const on = settings().window_controls;
                    void invoke("set_window_controls", { enabled: !on });
                    setSettings((s) => ({ ...s, window_controls: !on }));
                  }}
                >
                  <span class="tgl-track">
                    <span class="tgl-knob" />
                  </span>
                </button>
              </div>
            </div>
          </section>

          <section class="set-group">
            <div class="set-title">
              <Ico node={Download} size={13} /> Downloads
            </div>
            <div class="set-stack">
              <div class="set-block">
                <div class="set-sub">Folder</div>
                <p class="hint">
                  Default: <code>Music/Embertune</code>
                </p>
                <div class="dir-row">
                  <input id="dl-dir" type="text" readonly spellcheck={false} value={dlDir()} />
                  <button
                    id="dl-browse"
                    class="btn"
                    onClick={async () => {
                      const picked = await dialogOpen({ directory: true, multiple: false });
                      if (picked) setDlDir(picked);
                    }}
                  >
                    Browse…
                  </button>
                  <button
                    id="dl-save"
                    class="btn primary"
                    onClick={() => {
                      const dir = dlDir().trim();
                      if (!dir) return;
                      void invoke("set_download_dir", { dir });
                    }}
                  >
                    Set
                  </button>
                </div>
              </div>
              <div class="set-block">
                <div class="set-sub">Quality</div>
                <p class="hint">Best keeps original. MP3 re-encodes at fixed bitrate.</p>
                <div class="pill-row" id="quality-pills">
                  <For each={QUALITIES}>
                    {([q, label]) => (
                      <button
                        class="pill"
                        data-quality={q}
                        classList={{ active: settings().quality === q }}
                        onClick={() => applyQuality(q)}
                      >
                        {label}
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </div>
          </section>

          <section class="set-group">
            <div class="set-title">
              <Ico node={Music2} size={13} /> Spotify
            </div>
            <p class="hint">For Spotify links. Get keys from Spotify Dashboard.</p>
            <div class="spot-grid">
              <label class="field">
                Client ID{" "}
                <input ref={spotId} id="spot-id" type="text" spellcheck={false} />
              </label>
              <label class="field">
                Client Secret{" "}
                <input ref={spotSecret} id="spot-secret" type="password" spellcheck={false} />
              </label>
            </div>
            <button
              id="save-creds"
              class="btn primary"
              onClick={() => {
                // both fields via refs (audit Q1) — the Client ID used to be
                // read back through document.getElementById, the exact
                // reach-around pattern the prior audit removed
                const id = spotId.value.trim();
                const secret = spotSecret.value.trim();
                void invoke("set_spotify_creds", { clientId: id, clientSecret: secret });
              }}
            >
              Save credentials
            </button>
          </section>

          <section class="set-group tools">
            <div class="set-title">
              <Ico node={Wrench} size={13} /> Tools
            </div>
            <div class="set-row">
              <p class="hint" style="margin:0">
                Refresh yt-dlp and spotdl.
              </p>
              <button
                id="update-engines"
                class="btn primary tools-update"
                onClick={updateEngines}
                disabled={updating()}
              >
                <Ico node={RefreshCw} size={14} />
                <span>Update</span>
              </button>
            </div>
            <pre id="engine-log" classList={{ hidden: engineLog() === null }}>
              {engineLog() ?? ""}
            </pre>
          </section>
        </div>
      </div>
    </div>
  );
}
