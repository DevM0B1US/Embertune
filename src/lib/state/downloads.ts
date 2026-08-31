import { invoke } from "@tauri-apps/api/core";
import { createRoot, createSignal } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import type { JobView } from "../types";
import { toast } from "./ui";
import { sndDone } from "../sounds";

// ═══════════════════════════════════════════════════════════════════
//  Downloads store — active job map + coalesced reactive list.
//
//  Progress events arrive several times per second; the reactive list
//  is flushed at most every 120ms. Rate smoothing is folded into the
//  flush so components render pure data.
// ═══════════════════════════════════════════════════════════════════

const downloadsOwner = createRoot(() => {
  const [dlList, setDlList] = createSignal<JobView[]>([]);

  const dlMap = new Map<number, JobView>();
  const dlRate = new Map<number, { t: number; bytes: number; rate: number }>();

  let lastFlush = 0;
  let flushTimer: number | undefined;

  function flush(): void {
    const now = performance.now();
    const out: JobView[] = [];
    for (const j of dlMap.values()) {
      if (j.status === "downloading" && j.downloaded > 0) {
        const prev = dlRate.get(j.id);
        let rate = 0;
        if (prev && now > prev.t) {
          const inst = ((j.downloaded - prev.bytes) / (now - prev.t)) * 1000;
          rate = prev.rate > 0 ? prev.rate * 0.7 + inst * 0.3 : inst;
        }
        dlRate.set(j.id, { t: now, bytes: j.downloaded, rate });
        out.push({ ...j, rate });
      } else {
        out.push(j);
      }
    }
    for (const id of dlRate.keys()) if (!dlMap.has(id)) dlRate.delete(id);
    setDlList(out);
  }

  function scheduleFlush(): void {
    const now = performance.now();
    const dt = now - lastFlush;
    if (dt >= 120) {
      lastFlush = now;
      flush();
      return;
    }
    if (flushTimer === undefined) {
      flushTimer = window.setTimeout(() => {
        flushTimer = undefined;
        lastFlush = performance.now();
        flush();
      }, 120 - dt);
    }
  }

  function ingestJob(job: JobView): void {
    if (job.status === "completed" || job.status === "error" || job.status === "cancelled") {
      if (job.status === "completed") sndDone();
      if (job.status === "error") toast(`Download failed: ${job.error || "unknown"}`);
      dlMap.delete(job.id);
    } else {
      dlMap.set(job.id, job);
    }
    scheduleFlush();
  }

  async function queueUrl(url: string): Promise<void> {
    const id = await invoke<number>("add_download", { url });
    dlMap.set(id, {
      id,
      url,
      kind: url.includes("spotify") || url.startsWith("spotify:") ? "spotify" : "youtube",
      status: "queued",
      title: url,
      percent: -1,
      downloaded: 0,
      total: 0,
      error: null,
      skipped: false,
    });
    scheduleFlush();
  }

  /** Fetch existing jobs + subscribe to progress events. Returns cleanup. */
  function initDownloads(): () => void {
    const unsubs: Array<() => void> = [];
    void listen("download-progress", (e) => ingestJob(e.payload as JobView)).then((u) =>
      unsubs.push(u)
    );
    void (async () => {
      try {
        for (const job of await invoke<JobView[]>("list_downloads")) dlMap.set(job.id, job);
        scheduleFlush();
      } catch {
        /* no downloads backend */
      }
    })();
    return () => unsubs.forEach((u) => u());
  }

  return { dlList, queueUrl, initDownloads };
});

export const dlList = downloadsOwner.dlList;
export const queueUrl = downloadsOwner.queueUrl;
export const initDownloads = downloadsOwner.initDownloads;
