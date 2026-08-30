export function fmtDur(s: number): string {
  if (!s || s <= 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export function fmtSpeed(bps: number): string {
  if (bps >= 1024 * 1024) return `${(bps / 1024 / 1024).toFixed(2)} MB/s`;
  if (bps >= 1024) return `${Math.round(bps / 1024)} KB/s`;
  return `${Math.round(bps)} B/s`;
}

export function dlPercent(j: { percent: number }): string {
  if (j.percent < 0) return "…";
  return `${Math.round(j.percent)}%`;
}

export function dlStatusText(j: { status: string; error: string | null }): string {
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
