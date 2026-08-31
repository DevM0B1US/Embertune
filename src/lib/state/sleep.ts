import { invoke } from "@tauri-apps/api/core";
import { createRoot, createSignal } from "solid-js";
import { player, togglePlay } from "./player";
import { toast } from "./ui";

// ═══════════════════════════════════════════════════════════════════
//  Sleep timer — fully reactive. Components read `sleepRemainingMs`
//  (kept fresh by `tickRemaining` while the popover is open); expiry
//  is a single timeout plus a 1s watch interval as a safety net for
//  throttled background timers.
// ═══════════════════════════════════════════════════════════════════

const sleepOwner = createRoot(() => {
  const [sleepEnd, setSleepEnd] = createSignal<number | null>(null);
  const [sleepTotalMin, setSleepTotalMin] = createSignal<number | null>(null);
  const [sleepRemainingMs, setSleepRemainingMs] = createSignal<number | null>(null);

  let timeoutId: number | undefined;
  let watchInterval: number | undefined;

  function stopWatch(): void {
    if (watchInterval !== undefined) {
      window.clearInterval(watchInterval);
      watchInterval = undefined;
    }
  }

  function expire(): void {
    window.clearTimeout(timeoutId);
    timeoutId = undefined;
    stopWatch();
    setSleepEnd(null);
    setSleepTotalMin(null);
    setSleepRemainingMs(null);
    if (player().playing) togglePlay();
    toast("Sleep timer — paused");
  }

  function setSleepTimer(min: number): void {
    window.clearTimeout(timeoutId);
    timeoutId = undefined;
    stopWatch();
    if (min > 0) {
      setSleepEnd(Date.now() + min * 60000);
      setSleepTotalMin(min);
      setSleepRemainingMs(min * 60000);
      void invoke("set_sleep_timer", { minutes: min });
      timeoutId = window.setTimeout(expire, min * 60000);
      // safety net if timers were throttled while hidden
      watchInterval = window.setInterval(() => {
        const end = sleepEnd();
        if (end && Date.now() >= end) expire();
      }, 1000);
      toast(`Sleep timer: ${min} min`);
    } else {
      setSleepEnd(null);
      setSleepTotalMin(null);
      setSleepRemainingMs(null);
      void invoke("set_sleep_timer", { minutes: null });
      toast("Sleep timer off");
    }
  }

  /** Refresh the remaining-time signal (drives the popover countdown). */
  function tickRemaining(): void {
    const end = sleepEnd();
    setSleepRemainingMs(end ? Math.max(0, end - Date.now()) : null);
  }

  return { sleepEnd, sleepTotalMin, sleepRemainingMs, setSleepTimer, tickRemaining };
});

export const sleepTotalMin = sleepOwner.sleepTotalMin;
export const sleepRemainingMs = sleepOwner.sleepRemainingMs;
export const setSleepTimer = sleepOwner.setSleepTimer;
export const tickRemaining = sleepOwner.tickRemaining;

/** "mm:ss" for the popover countdown. */
export function fmtSleepRemaining(ms: number): string {
  const totalSecs = Math.floor(ms / 1000);
  const mm = Math.floor(totalSecs / 60);
  const ss = totalSecs % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}
