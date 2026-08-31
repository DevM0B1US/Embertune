// ═══════════════════════════════════════════════════════════════════
//  LRC parsing — extracted from LyricsPanel so it can be unit-tested
//  (audit TE1) and fixed in one place (audit B5).
// ═══════════════════════════════════════════════════════════════════

export interface LrcLine {
  t: number;
  text: string;
}

export interface ParseResult {
  /** Timed lines, sorted by timestamp — empty when not synced. */
  lines: LrcLine[];
  /** Plain (untimed) text — null when the source is synced. */
  plain: string | null;
}

// one timestamp: [mm:ss], [mm:ss.xx], [mm:ss.xxx] — hour form [hh:mm:ss.xx]
// is rare but legal, so minutes are allowed to run past 59
const TS = /\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\]/g;

/**
 * Parse LRC text. Handles the common repeated-lyrics form with several
 * timestamps on one line — `[00:01.00][00:45.00]Chorus` — which the old
 * single-match regex mangled: the second timestamp leaked into the lyric
 * text and the second occurrence was never indexed (audit B5).
 * One output line is emitted per timestamp. Metadata tags
 * ([ar:], [ti:], [by:], [offset:]…) and any other bracketed noise are
 * skipped; [offset:] shifts every timestamp.
 */
export function parseLrc(raw: string): ParseResult {
  let offsetMs = 0;
  const lines: LrcLine[] = [];
  let timed = false;
  let plain = "";

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // global metadata tag lines
    if (/^\[(ar|ti|al|by|length|re|ve|tool):/i.test(trimmed)) continue;
    const off = trimmed.match(/^\[offset:\s*([+-]?\d+)\s*\]$/i);
    if (off) {
      offsetMs = Number(off[1]);
      continue;
    }

    const stamps = [...trimmed.matchAll(TS)];
    if (stamps.length > 0) {
      timed = true;
      const text = trimmed.slice(stamps[stamps.length - 1]!.index! + stamps[stamps.length - 1]![0].length).trim();
      for (const m of stamps) {
        const secs = Number(m[1]) * 60 + Number(m[2]) - offsetMs / 1000;
        lines.push({ t: Math.max(0, Math.round(secs * 1000) / 1000), text });
      }
    } else if (!timed && !trimmed.startsWith("[")) {
      plain += line + "\n";
    }
  }

  lines.sort((a, b) => a.t - b.t);
  return timed
    ? { lines, plain: null }
    : { lines: [], plain: plain.trim() || null };
}
