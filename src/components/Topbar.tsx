import { invoke } from "@tauri-apps/api/core";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import { createEffect, createSignal, For, onCleanup } from "solid-js";
import {
  lyricsOpen,
  settingsOpen,
  setSettingsOpen,
  toast,
  toggleLyrics,
} from "../lib/state/ui";
import { settings } from "../lib/state/settings";
import { queueUrl } from "../lib/state/downloads";
import { refreshLibrary } from "../lib/state/library";
import {
  fmtSleepRemaining,
  setSleepTimer,
  sleepRemainingMs,
  sleepTotalMin,
  tickRemaining,
} from "../lib/state/sleep";
import { Ico } from "../lib/icons";
import { Mic, Minus, Maximize, Settings, Timer, X } from "lucide";
import logoUrl from "../assets/logo.svg";

// ── url input ───────────────────────────────────────────────────────
function autoGrow(el: HTMLTextAreaElement): void {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
}

const SLEEP_OPTIONS: Array<{ min: number; label: string }> = [
  { min: 0, label: "Off" },
  { min: 15, label: "15 minutes" },
  { min: 30, label: "30 minutes" },
  { min: 45, label: "45 minutes" },
  { min: 60, label: "1 hour" },
];

export default function Topbar() {
  let urlInput!: HTMLTextAreaElement;
  let customInput!: HTMLInputElement;

  // ── sleep popover ─────────────────────────────────────────────────
  let sleepPop!: HTMLDivElement;
  let btnSleep!: HTMLButtonElement;
  const [sleepOpen, setSleepOpen] = createSignal(false);

  const addUrls = (): void => {
    const raw = urlInput.value.trim();
    if (!raw) return;
    const urls = raw
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!urls.length) return;
    for (const u of urls) void queueUrl(u);
    urlInput.value = "";
    autoGrow(urlInput);
    toast(
      urls.length === 1
        ? "Added to queue — downloading…"
        : `Queued ${urls.length} downloads — one by one`
    );
  };

  const addLocalFiles = async (): Promise<void> => {
    const picked = await dialogOpen({
      multiple: true,
      filters: [
        { name: "Audio", extensions: ["mp3", "m4a", "opus", "ogg", "flac", "wav", "aac", "webm"] },
      ],
    });
    if (!picked) return;
    const list = Array.isArray(picked) ? picked : [picked];
    const res = await Promise.all(list.map((p) => invoke<boolean>("add_local_file", { path: p })));
    const added = res.filter(Boolean).length;
    toast(added ? `Added ${added} file${added === 1 ? "" : "s"}` : "Files already in library");
    await refreshLibrary();
  };

  // outside click closes the sleep popover
  const docClick = (e: MouseEvent): void => {
    if (!sleepOpen()) return;
    const t = e.target as HTMLElement;
    if (!sleepPop.contains(t) && !btnSleep.contains(t)) setSleepOpen(false);
  };
  document.addEventListener("click", docClick);
  onCleanup(() => document.removeEventListener("click", docClick));

  // countdown ticks only while the popover is open — 1s interval, not rAF
  // (audit P6): the display only changes per second, and the old 60fps rAF
  // loop re-rendered the popover ~60×/s for a value that moved 1/s
  createEffect(() => {
    if (!sleepOpen()) return;
    tickRemaining();
    const iv = window.setInterval(tickRemaining, 1000);
    onCleanup(() => window.clearInterval(iv));
  });

  const sleepCountdown = () => {
    const ms = sleepRemainingMs();
    return ms !== null ? fmtSleepRemaining(ms) : "—";
  };
  const sleepPercent = () => {
    const total = sleepTotalMin();
    const ms = sleepRemainingMs();
    if (!total || ms === null) return 0;
    return Math.max(0, Math.min(100, (ms / (total * 60000)) * 100));
  };

  const submitCustomMinutes = (): void => {
    const v = parseInt(customInput.value, 10);
    if (!v || v < 1 || v > 480) {
      toast("Enter 1–480 minutes");
      return;
    }
    setSleepTimer(v);
  };

  return (
    <header id="topbar" data-tauri-drag-region="">
      <div class="brand" title="Embertune" data-tauri-drag-region="true">
        <img
          class="brand-mark"
          src={logoUrl}
          alt="Embertune"
          draggable={false}
          data-tauri-drag-region="false"
        />
        <span class="brand-name" data-tauri-drag-region="true">
          Ember<b>tune</b>
        </span>
      </div>
      <textarea
        ref={urlInput}
        id="url-input"
        rows="1"
        placeholder="Paste YouTube or Spotify links — one per line…"
        spellcheck={false}
        onInput={(e) => autoGrow(e.currentTarget)}
        onKeyDown={(e) => {
          // Shift+Enter adds another line manually; plain Enter downloads
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            addUrls();
          }
        }}
      />
      <button id="add-btn" class="btn primary" onClick={() => addUrls()}>
        Add
      </button>
      <div class="topbar-sep" />
      <button id="local-btn" class="btn" title="Add local files from disk" onClick={() => void addLocalFiles()}>
        Add files
      </button>
      <button
        id="btn-lyrics"
        class="tbtn topbtn"
        title="Lyrics"
        aria-label="Lyrics"
        data-tauri-drag-region="false"
        classList={{ active: lyricsOpen() }}
        onClick={toggleLyrics}
      >
        <Ico node={Mic} size={16} />
      </button>
      <button
        ref={btnSleep}
        id="btn-sleep"
        class="tbtn topbtn"
        title="Sleep timer"
        aria-label="Sleep timer"
        data-tauri-drag-region="false"
        onClick={(e) => {
          e.stopPropagation();
          setSleepOpen(!sleepOpen());
        }}
      >
        <Ico node={Timer} size={16} />
      </button>
      <button
        id="btn-settings"
        class="tbtn topbtn"
        title="Settings"
        aria-label="Settings"
        data-tauri-drag-region="false"
        classList={{ active: settingsOpen() }}
        onClick={() => setSettingsOpen(!settingsOpen())}
      >
        <Ico node={Settings} size={16} />
      </button>

      <div id="win-controls" classList={{ hidden: !settings().window_controls }}>
        <button class="tbtn win-btn" id="btn-win-min" title="Minimize" aria-label="Minimize" onClick={() => void invoke("window_minimize")}>
          <Ico node={Minus} size={14} />
        </button>
        <button class="tbtn win-btn" id="btn-win-max" title="Maximize" aria-label="Maximize" onClick={() => void invoke("window_toggle_maximize")}>
          <Ico node={Maximize} size={13} />
        </button>
        <button class="tbtn win-btn win-close" id="btn-win-close" title="Close" aria-label="Close" onClick={() => void invoke("window_close")}>
          <Ico node={X} size={14} />
        </button>
      </div>

      <div ref={sleepPop} id="sleep-pop" classList={{ open: sleepOpen() }}>
        <div class="sleep-head">
          <div class="sleep-head-title">
            <Ico node={Timer} size={14} /> Sleep timer
          </div>
          <button
            id="sleep-close"
            class="tbtn"
            title="Close"
            onClick={(e) => {
              e.stopPropagation();
              setSleepOpen(false);
            }}
          >
            <Ico node={X} size={14} />
          </button>
        </div>
        <div class="sleep-count">
          <div class="sleep-time-row">
            <span id="sleep-time">{sleepCountdown()}</span>
            <span class="sleep-remaining">remaining</span>
          </div>
          <div class="sleep-bar">
            <div id="sleep-bar-fill" style={{ width: `${sleepPercent()}%` }} />
          </div>
        </div>
        <div id="sleep-pills-pop" class="sleep-options">
          <For each={SLEEP_OPTIONS}>
            {(opt) => (
              <button
                class="sleep-opt"
                classList={{ active: (sleepTotalMin() ?? 0) === opt.min }}
                onClick={() => setSleepTimer(opt.min)}
              >
                <span>{opt.label}</span>
              </button>
            )}
          </For>
        </div>
        <div class="sleep-custom">
          <input
            ref={customInput}
            type="number"
            min="1"
            max="480"
            placeholder="Custom minutes"
            onKeyDown={(e) => {
              if (e.key === "Enter") submitCustomMinutes();
            }}
          />
          <button id="sleep-custom-set" class="btn" onClick={submitCustomMinutes}>
            Set
          </button>
        </div>
      </div>
    </header>
  );
}
