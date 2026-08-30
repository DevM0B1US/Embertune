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
import { renderLibrary, refreshLibrary } from "./library";
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

export function renderDownloads(): void {
  const singles = [...downloads.values()];
  const panel = $("#downloads-panel");
  panel.classList.toggle("hidden", singles.length === 0);
  const list = $("#dl-list");
  list.innerHTML = "";
  for (const j of singles) list.appendChild(buildSingleRow(j));
  refreshIcons();
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
  renderLibrary();
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
