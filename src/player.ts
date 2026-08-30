import { invoke } from "@tauri-apps/api/core";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import {
  $,
  val,
  setVal,
  esc,
  fmtDur,
  toast,
  notify,
  sndClick,
  sndOpen,
  sndClose,
  sndDone,
  refreshIcons,
  setSndEnabled,
  state,
  sleepEnd,
  setSleepEnd,
  sleepTotalMin,
  setSleepTotalMin,
  lastNowId,
  setLastNowId,
  artCache,
  sndEnabled,
} from "./lib";
import { markPlayingRow, playTrack } from "./library";
import type { PlayerState, SeekTarget } from "./lib";

// --- lyrics ---
interface LrcLine {
  t: number;
  text: string;
}
let lrcLines: LrcLine[] = [];
let lrcReq = 0;

export async function loadLyrics(): Promise<void> {
  const t = state.current;
  const box = $("#lyrics-text");
  // Guard against out-of-order async resolution: when tracks change quickly,
  // an earlier (slower) get_lyrics call can resolve AFTER a newer one and
  // paint the previous song's lyrics over the current one. Only the latest
  // request is allowed to write.
  const req = ++lrcReq;
  if (!t) {
    lrcActiveIdx = -1;
    lrcLines = [];
    box.textContent = "No track playing.";
    return;
  }
  box.textContent = "Loading…";
  try {
    const raw = await invoke<string | null>("get_lyrics", {
      trackId: t.id,
      title: t.title,
      artist: t.artist,
      duration: t.duration,
    });
    if (req !== lrcReq) return;
    if (!raw) {
      lrcActiveIdx = -1;
      lrcLines = [];
      box.textContent = "No lyrics found for this track.";
      return;
    }
    lrcLines = [];
    const lines = raw.split("\n").filter((l) => l.trim());
    let timed = false;
    let plain = "";
    for (const line of lines) {
      const m = line.match(/^\[(\d{1,2}):(\d{2}(?:\.\d{1,3})?)\](.*)$/);
      if (m) {
        timed = true;
        const secs = Number(m[1]) * 60 + Number(m[2]);
        lrcLines.push({ t: secs, text: m[3].trim() });
      } else if (!timed) {
        plain += line + "\n";
      }
    }
    if (timed) {
      lrcActiveIdx = -1;
      box.innerHTML = "";
      for (const l of lrcLines) {
        const div = document.createElement("div");
        div.className = "lrc-line";
        div.textContent = l.text || "♪";
        div.dataset.t = String(l.t);
        box.appendChild(div);
      }
      updateLyrics();
    } else {
      lrcActiveIdx = -1;
      lrcLines = [];
      box.textContent = plain.trim() || "No lyrics found for this track.";
    }
  } catch {
    if (req !== lrcReq) return;
    box.textContent = "No lyrics found for this track.";
  }
}

let lrcActiveIdx = -1;
let lrcScrollRaf = 0;
let lrcLastAuto = 0;

// rAF-driven scroll for the lyrics box. Native `behavior:"smooth"` gets
// restarted (and stutters) in WebKit whenever a new scrollTo is issued, and
// fights the user when they scroll by hand — this gives full control.
function lrcScrollTo(target: number): void {
  const box = $("#lyrics-text");
  cancelAnimationFrame(lrcScrollRaf);
  const start = box.scrollTop;
  const diff = target - start;
  if (Math.abs(diff) < 1) return;
  const dur = Math.min(450, 120 + Math.abs(diff) * 0.35);
  const t0 = performance.now();
  const ease = (t: number) =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const step = (now: number) => {
    const p = Math.min(1, (now - t0) / dur);
    lrcLastAuto = performance.now();
    box.scrollTop = start + diff * ease(p);
    if (p < 1) lrcScrollRaf = requestAnimationFrame(step);
  };
  lrcScrollRaf = requestAnimationFrame(step);
}

export function updateLyrics(): void {
  const box = $("#lyrics-text");
  if (!lrcLines.length) return;
  let cur = 0;
  for (let i = 0; i < lrcLines.length; i++) {
    if (lrcLines[i].t <= state.position) cur = i;
    else break;
  }
  // Nothing moved — don't restart anything on the 500ms poll.
  if (cur === lrcActiveIdx) return;
  const prev = lrcActiveIdx;
  lrcActiveIdx = cur;
  const all = box.querySelectorAll<HTMLElement>(".lrc-line");
  if (prev >= 0 && prev < all.length) all[prev].classList.remove("active");
  const el = all[cur];
  el.classList.add("active");

  const bigJump = prev < 0 || cur - prev > 2;
  // Static content position of the active line inside the box.
  const elTop = el.offsetTop - box.offsetTop;
  const elBottom = elTop + el.offsetHeight;
  // Keep it centered without scrolling unless it drifts out of this band —
  // most line-to-line advances never scroll, which kills the stutter.
  const center = box.scrollTop + box.clientHeight / 2;
  const band = box.clientHeight * 0.22;
  const inView = elTop >= center - band && elBottom <= center + band;
  if (bigJump || !inView) {
    const max = Math.max(0, box.scrollHeight - box.clientHeight);
    const target = Math.min(
      max,
      Math.max(0, elTop - box.clientHeight / 2 + el.offsetHeight / 2),
    );
    if (bigJump) {
      lrcLastAuto = performance.now();
      box.scrollTop = target;
    } else {
      lrcScrollTo(target);
    }
  }
}

// Stop auto-scrolling the instant the user grabs the scrollbar.
$("#lyrics-text").addEventListener("scroll", () => {
  if (performance.now() - lrcLastAuto > 50) cancelAnimationFrame(lrcScrollRaf);
});

// --- transport — adaptive rAF: only 60fps when playing or seeking ---
let seekTarget: SeekTarget | null = null;
let seekBase = { pos: 0, at: 0 };
let visualPos = 0;
let frameRaf = 0;

function setSeekVis(pct: number): void {
  const v = Math.max(0, Math.min(100, pct));
  // use transform only — no layout thrash
  const fill = document.getElementById("seek-fill") as HTMLElement;
  const knob = document.getElementById("seek-knob") as HTMLElement;
  if (fill) fill.style.transform = `scaleX(${v / 100})`;
  if (knob) knob.style.left = `${v}%`;
}

function frameSeek(): void {
  frameRaf = 0;
  const now = Date.now();
  const st = seekTarget;
  const seeking = st && now - st.at < 800;
  const shouldRun = seeking || (state.playing && state.duration > 0);
  if (!shouldRun) {
    // idle: check again in 250ms instead of 16ms — saves 15fps+ when paused
    frameRaf = window.setTimeout(frameSeek as unknown as TimerHandler, 250) as unknown as number;
    return;
  }
  if (document.hidden) {
    // hidden tab: throttle to 4fps
    frameRaf = window.setTimeout(frameSeek as unknown as TimerHandler, 250) as unknown as number;
    return;
  }
  let target: number;
  if (seeking && st) {
    target = st.secs;
  } else if (state.playing && state.duration > 0) {
    target = seekBase.pos + ((now - seekBase.at) / 1000) * state.speed;
    if (target > state.duration) target = state.duration;
  } else {
    target = state.duration > 0 ? state.position : 0;
  }
  if (state.duration > 0) {
    // faster lerp when seeking, smoother when playing
    const lerp = seeking ? 0.5 : 0.3;
    visualPos += (target - visualPos) * lerp;
    // skip DOM write if delta < 0.05% to avoid sub-pixel churn
    const pct = (visualPos / state.duration) * 100;
    if (Math.abs(pct - parseFloat((document.getElementById("seek-fill") as HTMLElement)?.style.transform.match(/scaleX\(([^)]+)\)/)?.[1] || "0") * 100) > 0.05) {
      setSeekVis(pct);
    } else {
      // still need to set if never set
      setSeekVis(pct);
    }
    const seek = document.getElementById("seek") as HTMLInputElement | null;
    if (seek && document.activeElement !== seek) {
      seek.value = String(Math.min(1000, (visualPos / state.duration) * 1000));
    }
    const curEl = document.getElementById("time-cur");
    if (curEl) curEl.textContent = fmtDur(seeking ? st!.secs : visualPos);
  }
  frameRaf = requestAnimationFrame(frameSeek);
}
function kickFrameSeek(): void {
  if (!frameRaf) frameRaf = requestAnimationFrame(frameSeek);
}
frameRaf = requestAnimationFrame(frameSeek);

$("#btn-play").addEventListener("click", () => void invoke("toggle_play"));
$("#btn-next").addEventListener("click", () => void invoke("player_next"));
$("#btn-prev").addEventListener("click", () => void invoke("player_prev"));
$("#seek").addEventListener("input", () => {
  const v = Number(val("#seek"));
  const pct = v / 10;
  seekTarget = { pct, secs: (state.duration * v) / 1000, at: Date.now() };
  setSeekVis(pct);
});
$("#seek").addEventListener("change", () => {
  const v = Number(val("#seek"));
  const pct = v / 10;
  const st = { pct, secs: (state.duration * v) / 1000, at: Date.now() };
  seekTarget = st;
  setSeekVis(pct);
  void invoke("player_seek", { secs: st.secs });
});
$("#volume").addEventListener("input", (e) =>
  void invoke("player_set_volume", { volume: Number((e.target as HTMLInputElement).value) }),
);

// shuffle / repeat / speed
$("#btn-shuffle").addEventListener("click", () => {
  const on = !(state.shuffle || false);
  void invoke("set_shuffle", { on });
  state.shuffle = on;
  $("#btn-shuffle").classList.toggle("active", on);
  toast(on ? "Shuffle on" : "Shuffle off");
});

const REPEAT_NEXT: Record<string, string> = { off: "all", all: "one", one: "off" };
$("#btn-repeat").addEventListener("click", () => {
  const next = REPEAT_NEXT[state.repeat || "off"] || "off";
  void invoke("set_repeat", { mode: next });
  state.repeat = next;
  updateRepeatBtn();
});

function updateRepeatBtn(): void {
  const b = $("#btn-repeat");
  const mode = state.repeat || "off";
  b.dataset.mode = mode;
  b.classList.toggle("active", mode !== "off");
  b.title = mode === "one" ? "Repeat: one" : mode === "all" ? "Repeat: all" : "Repeat: off";
}

const SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
$("#btn-speed").addEventListener("click", () => {
  const cur = state.speed || 1.0;
  const idx = SPEEDS.findIndex((s) => Math.abs(s - cur) < 0.001);
  const next = SPEEDS[(idx + 1) % SPEEDS.length]!;
  void invoke("set_speed", { speed: next });
  state.speed = next;
  updateSpeedBtn();
});

function updateSpeedBtn(): void {
  const v = state.speed || 1.0;
  const label = Number.isInteger(v) ? `${v}.0×` : `${v}×`;
  $("#btn-speed").textContent = label;
}

// sleep timer — standardized + optimized (single timeout + rAF only when open)
let sleepTimeout: number | undefined;
let sleepRaf = 0;
function setSleepTimer(min: number): void {
  if (sleepTimeout) { clearTimeout(sleepTimeout); sleepTimeout = undefined; }
  if (sleepRaf) { cancelAnimationFrame(sleepRaf); sleepRaf = 0; }
  setSleepEnd(min ? Date.now() + min * 60000 : null);
  setSleepTotalMin(min || null);
  const sel = String(min);
  // support both old .pill and new .sleep-opt
  document.querySelectorAll("#sleep-pills-pop .sleep-opt, #sleep-pills-pop .pill").forEach((p) =>
    (p as HTMLElement).classList.toggle("active", (p as HTMLElement).dataset.min === sel));
  const sP = document.getElementById("sleep-pills");
  if (sP) sP.querySelectorAll(".pill").forEach((p) => (p as HTMLElement).classList.toggle("active", (p as HTMLElement).dataset.min === sel));
  void invoke("set_sleep_timer", { minutes: min || null });
  if (min) {
    const ms = min * 60000;
    sleepTimeout = window.setTimeout(() => {
      setSleepEnd(null);
      setSleepTotalMin(null);
      updateSleepRing();
      stopSleepRing();
      if (state.playing) void invoke("toggle_play");
      toast("Sleep timer — paused");
    }, ms);
    startSleepRing();
  } else {
    stopSleepRing();
  }
  toast(sleepEnd ? `Sleep timer: ${min} min` : "Sleep timer off");
  updateSleepRing();
  refreshIcons();
}
function updateSleepRing(): void {
  const timeEl = document.getElementById("sleep-time");
  const bar = document.getElementById("sleep-bar-fill") as HTMLElement | null;
  if (!sleepEnd || !sleepTotalMin) {
    if (timeEl) timeEl.textContent = "—";
    if (bar) bar.style.width = "0%";
    return;
  }
  const remain = Math.max(0, sleepEnd - Date.now());
  const totalSecs = Math.floor(remain / 1000);
  const mm = Math.floor(totalSecs / 60);
  const ss = totalSecs % 60;
  if (timeEl) timeEl.textContent = `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  const frac = remain / (sleepTotalMin * 60000);
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, frac * 100))}%`;
}
function startSleepRing(): void {
  if (sleepRaf) cancelAnimationFrame(sleepRaf);
  sleepRaf = requestAnimationFrame(function loop() {
    sleepRaf = 0;
    updateSleepRing();
    if (sleepEnd && document.getElementById("sleep-pop")?.classList.contains("open")) {
      sleepRaf = requestAnimationFrame(loop);
    }
  });
}
function stopSleepRing(): void {
  if (sleepRaf) { cancelAnimationFrame(sleepRaf); sleepRaf = 0; }
}
function updateSleepBtn(): void {
  // kept for pollPlayer compat — expiry now handled by setTimeout, just update ring
  if (!sleepEnd) return;
  if (Date.now() >= sleepEnd) {
    if (sleepTimeout) { clearTimeout(sleepTimeout); sleepTimeout = undefined; }
    setSleepEnd(null);
    setSleepTotalMin(null);
    updateSleepRing();
    stopSleepRing();
    if (state.playing) void invoke("toggle_play");
    toast("Sleep timer — paused");
  }
}

const sleepPop = document.getElementById("sleep-pop") as HTMLElement | null;
const btnSleep = document.getElementById("btn-sleep") as HTMLElement | null;
if (btnSleep && sleepPop) {
  btnSleep.addEventListener("click", (e) => {
    e.stopPropagation();
    const willOpen = !sleepPop.classList.contains("open");
    sleepPop.classList.toggle("open", willOpen);
    if (willOpen) {
      updateSleepRing();
      if (sleepEnd) startSleepRing();
      try { refreshIcons(); } catch {}
    } else {
      stopSleepRing();
    }
  });
  console.log("[sleep] btn-sleep listener attached");
} else {
  console.error("[sleep] btn or pop not found", !!btnSleep, !!sleepPop);
}
(document.getElementById("sleep-close") as HTMLElement | null)?.addEventListener("click", (e) => {
  e.stopPropagation();
  const pop = document.getElementById("sleep-pop") as HTMLElement | null;
  if (!pop) return;
  pop.classList.remove("open");
  stopSleepRing();
});
$("#sleep-pills-pop").addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest(".sleep-opt, .pill") as HTMLElement | null;
  if (!btn || btn.dataset.min === undefined) return;
  setSleepTimer(Number(btn.dataset.min));
});
$("#sleep-custom-set").addEventListener("click", () => {
  const inp = $("#sleep-custom-input") as HTMLInputElement;
  const v = parseInt(inp.value, 10);
  if (!v || v < 1 || v > 480) { toast("Enter 1–480 minutes"); return; }
  setSleepTimer(v);
});
$("#sleep-custom-input").addEventListener("keydown", (e) => {
  if ((e as KeyboardEvent).key === "Enter") ($("#sleep-custom-set") as HTMLElement).click();
});
document.addEventListener("click", (e) => {
  if (!sleepPop.classList.contains("open")) return;
  const t = e.target as HTMLElement;
  if (!sleepPop.contains(t) && !$("#btn-sleep").contains(t)) {
    sleepPop.classList.remove("open");
    stopSleepRing();
  }
});

// keyboard shortcuts
document.addEventListener("keydown", (e) => {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  switch (e.key) {
    case " ":
      e.preventDefault();
      void invoke("toggle_play");
      break;
    case "ArrowLeft":
      e.preventDefault();
      void invoke("player_seek", { secs: Math.max(0, state.position - 5) });
      break;
    case "ArrowRight":
      e.preventDefault();
      void invoke("player_seek", { secs: state.position + 5 });
      break;
    case "ArrowUp":
      e.preventDefault();
      void invoke("player_set_volume", { volume: Math.min(100, (state.volume || 0) + 5) });
      break;
    case "ArrowDown":
      e.preventDefault();
      void invoke("player_set_volume", { volume: Math.max(0, (state.volume || 0) - 5) });
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
      $("#search").focus();
      break;
  }
});

// --- poll player ---
function applyMarquee(el: HTMLElement, text: string): void {
  if (el.getAttribute("data-txt") === text) return;
  el.setAttribute("data-txt", text);
  el.classList.remove("marquee");
  el.textContent = text;
  if (el.scrollWidth <= el.clientWidth + 2) return;
  el.classList.add("marquee");
  const track = document.createElement("span");
  track.className = "m-track";
  for (let i = 0; i < 2; i++) {
    const copy = document.createElement("span");
    copy.className = "m-copy";
    copy.textContent = text;
    track.appendChild(copy);
  }
  el.replaceChildren(track);
  const secs = Math.min(24, Math.max(6, text.length * 0.2));
  track.style.animationDuration = `${secs}s`;
}

window.addEventListener("resize", () => {
  for (const id of ["#now-title", "#now-artist"]) {
    const el = document.querySelector(id) as HTMLElement | null;
    if (el) {
      el.removeAttribute("data-txt");
      applyMarquee(el, el.textContent || "");
    }
  }
});

let pollCache: { btnPlay: HTMLElement | null; playerEl: HTMLElement | null; nowTitle: HTMLElement | null; nowArtist: HTMLElement | null; timeTotal: HTMLElement | null; btnShuffle: HTMLElement | null; seek: HTMLInputElement | null; vol: HTMLInputElement | null } | null = null;
function getPollEls() {
  if (pollCache) return pollCache;
  pollCache = {
    btnPlay: document.getElementById("btn-play"),
    playerEl: document.getElementById("player"),
    nowTitle: document.getElementById("now-title"),
    nowArtist: document.getElementById("now-artist"),
    timeTotal: document.getElementById("time-total"),
    btnShuffle: document.getElementById("btn-shuffle"),
    seek: document.getElementById("seek") as HTMLInputElement | null,
    vol: document.getElementById("volume") as HTMLInputElement | null,
  };
  return pollCache;
}
let lastPollStatePlaying = false;
export async function pollPlayer(): Promise<void> {
  // throttle hidden tab to 1s to save IPC + wakeups
  if (document.hidden) {
    // still need to poll occasionally for sleep timer, but slower
    const now = Date.now();
    // @ts-ignore
    if ((pollPlayer as any)._lastHidden && now - (pollPlayer as any)._lastHidden < 1000) return;
    (pollPlayer as any)._lastHidden = now;
  }
  try {
    Object.assign(state, await invoke<PlayerState>("get_player_state"));
  } catch {
    return;
  }
  const els = getPollEls();
  if (els.btnPlay) {
    const ip = els.btnPlay.querySelector(".icon-play") as HTMLElement | null;
    const ap = els.btnPlay.querySelector(".icon-pause") as HTMLElement | null;
    if (ip) ip.classList.toggle("hidden", state.playing);
    if (ap) ap.classList.toggle("hidden", !state.playing);
  }
  if (els.playerEl) els.playerEl.classList.toggle("playing", state.playing);
  // marquee — only when text actually changed (applyMarquee already bails)
  if (els.nowTitle) applyMarquee(els.nowTitle, state.current ? state.current.title : "—");
  if (els.nowArtist) applyMarquee(els.nowArtist, state.current && state.current.artist ? state.current.artist : "");
  if (els.timeTotal) els.timeTotal.textContent = fmtDur(state.duration);
  updateRepeatBtn();
  updateSpeedBtn();
  if (els.btnShuffle) els.btnShuffle.classList.toggle("active", !!state.shuffle);
  updateSleepBtn();
  markPlayingRow();
  // kick/pause frameSeek based on playing transition
  if (state.playing !== lastPollStatePlaying) {
    lastPollStatePlaying = state.playing;
    kickFrameSeek();
  }

  if (state.current && state.current.id !== lastNowId) {
    setLastNowId(state.current.id);
    const nowEl = $("#now");
    nowEl.classList.remove("now-in");
    void nowEl.offsetWidth;
    nowEl.classList.add("now-in");
    void loadNowArt();
    if ($("#lyrics-panel").classList.contains("open")) void loadLyrics();
  } else if ($("#lyrics-panel").classList.contains("open")) {
    updateLyrics();
  }

  const st = seekTarget;
  const seeking = st && Date.now() - st.at < 800;
  seekBase.pos = state.position;
  seekBase.at = Date.now();
  if (state.duration > 0 && Math.abs(visualPos - state.position) > state.duration * 0.05) {
    visualPos = state.position;
  }
  if (!seeking) {
    const seek = els.seek;
    if (seek && document.activeElement !== seek && state.duration > 0) {
      seek.value = String(Math.min(1000, (state.position / state.duration) * 1000));
    }
  }
  const vol = els.vol;
  if (vol && document.activeElement !== vol) vol.value = String(state.volume);
}

async function loadNowArt(): Promise<void> {
  const t = state.current;
  const img = $("#now-art-img") as HTMLImageElement;
  const fallback = $(".thumb-fallback");
  if (!t) {
    img.classList.add("hidden");
    fallback.classList.remove("hidden");
    return;
  }
  if (artCache.has(t.id)) {
    setNowArt(artCache.get(t.id)!, img, fallback);
    return;
  }
  try {
    const p = await invoke<string | null>("get_art", { trackId: t.id });
    if (p) {
      if (artCache.size >= 120) {
        const first = artCache.keys().next().value;
        if (first !== undefined) artCache.delete(first as number);
      }
      artCache.set(t.id, p);
      setNowArt(p, img, fallback);
    } else {
      img.classList.add("hidden");
      fallback.classList.remove("hidden");
    }
  } catch {
    img.classList.add("hidden");
    fallback.classList.remove("hidden");
  }
}

function setNowArt(p: string, img: HTMLImageElement, fallback: HTMLElement): void {
  img.src = p;
  img.classList.remove("hidden");
  fallback.classList.add("hidden");
}

// CSP-safe: no inline onerror — listener lives here instead.
$("#now-art-img").addEventListener("error", () => {
  ($("#now-art-img") as HTMLImageElement).classList.add("hidden");
  $(".thumb-fallback").classList.remove("hidden");
});

// --- settings ---
function applyTheme(t: string): void {
  document.documentElement.dataset.theme = t;
  $("#theme-pills")
    .querySelectorAll(".pill")
    .forEach((p) => p.classList.toggle("active", (p as HTMLElement).dataset.theme === t));
}

$("#theme-pills").addEventListener("click", (e) => {
  const pill = (e.target as HTMLElement).closest(".pill") as HTMLElement | null;
  if (!pill || !pill.dataset.theme) return;
  applyTheme(pill.dataset.theme);
  void invoke("set_theme", { theme: pill.dataset.theme });
});

export async function loadSettings(): Promise<void> {
  const s = await invoke<{
    spotify_client_id: string | null;
    has_spotify_creds: boolean;
    quality: string;
    theme: string;
    window_controls: boolean;
  }>("get_settings");
  setVal("#spot-id", s.spotify_client_id || "");
  // Never populate the secret into the DOM — show placeholder only.
  const secretEl = $("#spot-secret") as HTMLInputElement;
  secretEl.value = "";
  secretEl.placeholder = s.has_spotify_creds ? "••••••••" : "";
  setVal("#dl-dir", await invoke<string>("get_download_dir"));
  applyQualityPill(s.quality || "best");
  applyTheme(s.theme || "glass");
  (document.getElementById("win-toggle") as HTMLButtonElement).setAttribute("aria-checked", String(!!s.window_controls));
  $("#win-controls").classList.toggle("hidden", !s.window_controls);
}

// --- window controls ---
const winToggleEl = document.getElementById("win-toggle") as HTMLButtonElement;
winToggleEl.addEventListener("click", () => {
  const on = winToggleEl.getAttribute("aria-checked") !== "true";
  winToggleEl.setAttribute("aria-checked", String(on));
  void invoke("set_window_controls", { enabled: on });
  $("#win-controls").classList.toggle("hidden", !on);
});

$("#btn-win-min").addEventListener("click", () => void invoke("window_minimize"));
$("#btn-win-max").addEventListener("click", () => void invoke("window_toggle_maximize"));
$("#btn-win-close").addEventListener("click", () => void invoke("window_close"));

function applyQualityPill(v: string): void {
  $("#quality-pills")
    .querySelectorAll(".pill")
    .forEach((p) => p.classList.toggle("active", (p as HTMLElement).dataset.quality === v));
}

$("#quality-pills").addEventListener("click", (e) => {
  const pill = (e.target as HTMLElement).closest(".pill") as HTMLElement | null;
  if (!pill || !pill.dataset.quality) return;
  applyQualityPill(pill.dataset.quality);
  void invoke("set_download_quality", { quality: pill.dataset.quality });
});

$("#dl-browse").addEventListener("click", async () => {
  const picked = await dialogOpen({ directory: true, multiple: false });
  if (picked) setVal("#dl-dir", picked);
});

$("#dl-save").addEventListener("click", () => {
  const dir = val("#dl-dir").trim();
  if (!dir) return;
  void invoke("set_download_dir", { dir });
});

$("#save-creds").addEventListener("click", () => {
  void invoke("set_spotify_creds", {
    clientId: val("#spot-id").trim(),
    clientSecret: val("#spot-secret").trim(),
  });
});

// --- UI sounds toggle (hidden from settings — keep sounds on, respect localStorage) ---
const sndEl = document.getElementById("snd-toggle") as HTMLButtonElement | null;
if (sndEl) {
  sndEl.setAttribute("aria-checked", String(sndEnabled));
  sndEl.addEventListener("click", () => {
    setSndEnabled(sndEl.getAttribute("aria-checked") !== "true");
    sndEl.setAttribute("aria-checked", String(sndEnabled));
    localStorage.setItem("embertune.sound", sndEnabled ? "on" : "off");
    if (sndEnabled) sndClick();
  });
}

$("#update-engines").addEventListener("click", () => {
  const log = $("#engine-log");
  log.textContent = "Updating…";
  log.classList.remove("hidden");
  void invoke("update_engines");
});
