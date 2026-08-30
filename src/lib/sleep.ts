import { invoke } from "@tauri-apps/api/core";
import {
  sleepEnd,
  setSleepEnd,
  sleepTotalMin,
  setSleepTotalMin,
  toast,
  player,
} from "./state";

// Sleep timer — single timeout + rAF ring updates only while the
// popover is open (ported 1:1 from the vanilla build).
let sleepTimeout: number | undefined;
let sleepRaf = 0;

export function setSleepTimer(min: number): void {
  if (sleepTimeout) {
    clearTimeout(sleepTimeout);
    sleepTimeout = undefined;
  }
  if (sleepRaf) {
    cancelAnimationFrame(sleepRaf);
    sleepRaf = 0;
  }
  setSleepEnd(min ? Date.now() + min * 60000 : null);
  setSleepTotalMin(min || null);
  const sel = String(min);
  document
    .querySelectorAll("#sleep-pills-pop .sleep-opt, #sleep-pills-pop .pill")
    .forEach((p) => (p as HTMLElement).classList.toggle("active", (p as HTMLElement).dataset.min === sel));
  void invoke("set_sleep_timer", { minutes: min || null });
  if (min) {
    const ms = min * 60000;
    sleepTimeout = window.setTimeout(() => {
      setSleepEnd(null);
      setSleepTotalMin(null);
      updateSleepRing();
      stopSleepRing();
      if (player().playing) void invoke("toggle_play");
      toast("Sleep timer — paused");
    }, ms);
    startSleepRing();
  } else {
    stopSleepRing();
  }
  toast(sleepEnd() ? `Sleep timer: ${min} min` : "Sleep timer off");
  updateSleepRing();
}

export function updateSleepRing(): void {
  const timeEl = document.getElementById("sleep-time");
  const bar = document.getElementById("sleep-bar-fill") as HTMLElement | null;
  const end = sleepEnd();
  const totalMin = sleepTotalMin();
  if (!end || !totalMin) {
    if (timeEl) timeEl.textContent = "—";
    if (bar) bar.style.width = "0%";
    return;
  }
  const remain = Math.max(0, end - Date.now());
  const totalSecs = Math.floor(remain / 1000);
  const mm = Math.floor(totalSecs / 60);
  const ss = totalSecs % 60;
  if (timeEl) timeEl.textContent = `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  const frac = remain / (totalMin * 60000);
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, frac * 100))}%`;
}

function startSleepRing(): void {
  if (sleepRaf) cancelAnimationFrame(sleepRaf);
  sleepRaf = requestAnimationFrame(function loop() {
    sleepRaf = 0;
    updateSleepRing();
    if (sleepEnd() && document.getElementById("sleep-pop")?.classList.contains("open")) {
      sleepRaf = requestAnimationFrame(loop);
    }
  });
}

export function stopSleepRing(): void {
  if (sleepRaf) {
    cancelAnimationFrame(sleepRaf);
    sleepRaf = 0;
  }
}

// kept for poll parity — expiry now handled by setTimeout, this is a
// safety net if timers were throttled while hidden
export function updateSleepBtn(): void {
  const end = sleepEnd();
  if (!end) return;
  if (Date.now() >= end) {
    if (sleepTimeout) {
      clearTimeout(sleepTimeout);
      sleepTimeout = undefined;
    }
    setSleepEnd(null);
    setSleepTotalMin(null);
    updateSleepRing();
    stopSleepRing();
    if (player().playing) void invoke("toggle_play");
    toast("Sleep timer — paused");
  }
}
