import { invoke } from "@tauri-apps/api/core";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import {
  $,
  val,
  setVal,
  esc,
  refreshIcons,
  toast,
  downloads,
  dlRate,
} from "./lib";
import { refreshLibrary } from "./library";
import type { JobView } from "./lib";

// --- add url ---
function dlPercent(j: JobView): string {
  if (j.percent < 0) return "…";
  return `${Math.round(j.percent)}%`;
}

function fmtSpeed(bps: number): string {
  if (bps >= 1024 * 1024) return `${(bps / 1024 / 1024).toFixed(2)} MB/s`;
  if (bps >= 1024) return `${Math.round(bps / 1024)} KB/s`;
  return `${Math.round(bps)} B/s`;
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function speedFor(id: number, downloaded: number, status: string): string {
  if (status !== "downloading" || downloaded <= 0) return "";
  // prune stale entries (keep map small)
  if (dlRate.size > 40) {
    const now2 = performance.now();
    for (const [k, v] of dlRate) if (now2 - v.t > 60000) dlRate.delete(k);
  }
  const now = performance.now();
  const prev = dlRate.get(id);
  let rate: number;
  if (prev && now > prev.t) {
    const dt = (now - prev.t) / 1000;
    const inst = dt > 0 ? (downloaded - prev.bytes) / dt : 0;
    rate = prev.rate > 0 ? prev.rate * 0.7 + inst * 0.3 : inst;
  } else {
    rate = 0;
  }
  dlRate.set(id, { t: now, bytes: downloaded, rate });
  return rate > 0 ? fmtSpeed(rate) : "";
}

function trackSpeed(j: JobView): string {
  return speedFor(j.id, j.downloaded, j.status);
}

function dlStatusText(j: JobView): string {
  switch (j.status) {
    case "queued":
      return "Resolving…";
    case "downloading":
      return "Downloading";
    case "completed":
      return "Done";
    case "cancelled":
      return "Cancelled";
    case "error":
      return `Error: ${j.error || "unknown"}`;
    default:
      return j.status;
  }
}

let dlIconsRaf = 0;
let lastDlIcons = 0;

// Progress events arrive several times per second per job; rebuilding
// the panel on every event is wasted work. Coalesce to ~8fps — the
// .dl-fill width transition smooths the bars between renders.
let lastRenderAt = 0;
let pendingTimer: number | undefined;

function scheduleRender(): void {
  const now = performance.now();
  const dt = now - lastRenderAt;
  if (dt >= 120) {
    lastRenderAt = now;
    renderDownloadsNow();
    return;
  }
  if (pendingTimer === undefined) {
    pendingTimer = window.setTimeout(() => {
      pendingTimer = undefined;
      lastRenderAt = performance.now();
      renderDownloadsNow();
    }, 120 - dt);
  }
}

export function renderDownloads(): void {
  scheduleRender();
}

function renderDownloadsNow(): void {
  const singles = [...downloads.values()];
  const panel = document.getElementById("downloads-panel") as HTMLElement;
  panel.classList.toggle("hidden", singles.length === 0);
  const list = document.getElementById("dl-list") as HTMLElement;
  // single document fragment — avoids N layout thrashes
  const frag = document.createDocumentFragment();
  for (const j of singles) frag.appendChild(buildSingleRow(j));
  list.replaceChildren(frag);
  // throttle icon refresh to 150ms
  const now = performance.now();
  if (now - lastDlIcons < 150) {
    if (!dlIconsRaf) dlIconsRaf = requestAnimationFrame(() => { dlIconsRaf = 0; lastDlIcons = performance.now(); refreshIcons(); });
    return;
  }
  lastDlIcons = now;
  requestAnimationFrame(() => refreshIcons());
  // cleanup dlRate for finished jobs
  for (const [id] of dlRate) if (!singles.some((j) => j.id === id)) dlRate.delete(id);
}

function buildSingleRow(j: JobView): HTMLLIElement {
  const active = j.status === "queued" || j.status === "downloading";
  const pct = j.percent < 0 ? 0 : Math.round(j.percent);
  const sp = j.status === "downloading" ? trackSpeed(j) : "";
  const bytes = j.downloaded > 0 ? fmtBytes(j.downloaded) : "";
  const isUrl = /^https?:\/\//.test(j.title);
  let sub: string;
  if (j.skipped) {
    sub = "Skipped — already in library";
  } else {
    const bits: string[] = [dlStatusText(j)];
    if (sp) bits.push(sp);
    if (bytes) bits.push(bytes);
    if (j.percent >= 0) bits.push(dlPercent(j));
    if (isUrl && j.status === "queued") bits.push("· pending");
    sub = bits.join(" · ");
  }
  const li = document.createElement("li");
  li.className = "track dl-row";
  li.innerHTML = `
    <div class="track-meta">
      <div class="track-title">${active ? '<span class="spinner"></span>' : ""}${esc(j.title || "Resolving…")}</div>
      <div class="track-sub">${esc(sub)}</div>
    </div>
    <div class="dl-progress"><div class="dl-fill" style="width:${pct}%"></div></div>
  `;
  return li;
}

async function queueUrl(url: string): Promise<void> {
  const id = await invoke<number>("add_download", { url });
  downloads.set(id, {
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
  renderDownloads();
}

function autoGrow(el: HTMLTextAreaElement): void {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
}

function addUrls(): void {
  const raw = val("#url-input").trim();
  if (!raw) return;
  const urls = raw
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!urls.length) return;
  for (const u of urls) void queueUrl(u);
  setVal("#url-input", "");
  autoGrow($("#url-input"));
  toast(
    urls.length === 1
      ? "Added to queue — downloading…"
      : `Queued ${urls.length} downloads — one by one`,
  );
}

const urlInput = $("#url-input") as HTMLTextAreaElement;
urlInput.addEventListener("input", () => autoGrow(urlInput));
urlInput.addEventListener("keydown", (e) => {
  // Shift+Enter lets you add another line manually; plain Enter downloads
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    addUrls();
  }
});
$("#add-btn").addEventListener("click", () => addUrls());

// --- local files ---
$("#local-btn").addEventListener("click", async () => {
  const picked = await dialogOpen({
    multiple: true,
    filters: [{ name: "Audio", extensions: ["mp3", "m4a", "opus", "ogg", "flac", "wav", "aac", "webm"] }],
  });
  if (!picked) return;
  const list = Array.isArray(picked) ? picked : [picked];
  const res = await Promise.all(
    list.map((p) => invoke<boolean>("add_local_file", { path: p })),
  );
  const added = res.filter(Boolean).length;
  toast(added ? `Added ${added} file${added === 1 ? "" : "s"}` : "Files already in library");
  await refreshLibrary();
});
