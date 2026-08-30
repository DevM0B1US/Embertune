import { For } from "solid-js";
import { dlList, dlRate } from "../lib/state";
import { dlPercent, dlStatusText, fmtBytes, fmtSpeed } from "../lib/format";
import type { JobView } from "../lib/types";

function speedFor(id: number, downloaded: number, status: string): string {
  if (status !== "downloading" || downloaded <= 0) return "";
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

function subText(j: JobView): string {
  if (j.skipped) return "Skipped — already in library";
  const isUrl = /^https?:\/\//.test(j.title);
  const bits: string[] = [dlStatusText(j)];
  const sp = j.status === "downloading" ? speedFor(j.id, j.downloaded, j.status) : "";
  if (sp) bits.push(sp);
  if (j.downloaded > 0) bits.push(fmtBytes(j.downloaded));
  if (j.percent >= 0) bits.push(dlPercent(j));
  if (isUrl && j.status === "queued") bits.push("· pending");
  return bits.join(" · ");
}

function DlRow(props: { j: JobView }) {
  const j = props.j;
  const active = j.status === "queued" || j.status === "downloading";
  const pct = j.percent < 0 ? 0 : Math.round(j.percent);
  return (
    <li class="track dl-row">
      <div class="track-meta">
        <div class="track-title">
          {active ? <span class="spinner" /> : ""}
          {j.title || "Resolving…"}
        </div>
        <div class="track-sub">{subText(j)}</div>
      </div>
      <div class="dl-progress">
        <div class="dl-fill" style={{ width: `${pct}%` }} />
      </div>
    </li>
  );
}

export default function DownloadsPanel() {
  return (
    <div id="downloads-panel" classList={{ hidden: dlList().length === 0 }}>
      <ul id="dl-list">
        <For each={dlList()}>{(j) => <DlRow j={j} />}</For>
      </ul>
    </div>
  );
}
