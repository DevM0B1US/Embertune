import { For } from "solid-js";
import { dlList } from "../lib/state/downloads";
import { dlPercent, dlStatusText, fmtBytes, fmtSpeed } from "../lib/format";
import type { JobView } from "../lib/types";

function subText(j: JobView): string {
  if (j.skipped) return "Skipped — already in library";
  const isUrl = /^https?:\/\//.test(j.title);
  const bits: string[] = [dlStatusText(j)];
  if (j.status === "downloading" && (j.rate ?? 0) > 0) bits.push(fmtSpeed(j.rate!));
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
