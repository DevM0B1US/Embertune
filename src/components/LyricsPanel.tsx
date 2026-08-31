import { createEffect, createSignal, For, on, onCleanup, untrack } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { Maximize, Minimize, X } from "lucide";
import { Ico } from "../lib/icons";
import { parseLrc, type LrcLine } from "../lib/lrc";
import { currentId, player } from "../lib/state/player";
import { lyricsFs, lyricsOpen, setLyricsFs, setLyricsOpen } from "../lib/state/ui";

// ── lyrics parsing lives in lib/lrc.ts (unit-tested) ───────────────

export default function LyricsPanel() {
  let box!: HTMLDivElement;
  const [lrcLines, setLrcLines] = createSignal<LrcLine[]>([]);
  const [plainText, setPlainText] = createSignal<string | null>(null);
  const [activeIdx, setActiveIdx] = createSignal(-1);

  // row elements captured via refs — no per-line DOM queries
  let lineEls: HTMLElement[] = [];

  let lrcReq = 0;
  let lrcScrollRaf = 0;
  let lrcLastAuto = 0;

  // rAF-driven scroll — native smooth gets restarted/stutters in WebKit
  // (prefers-reduced-motion, audit U5: no eased glide — jump straight)
  function lrcScrollTo(target: number): void {
    cancelAnimationFrame(lrcScrollRaf);
    const start = box.scrollTop;
    const diff = target - start;
    if (Math.abs(diff) < 1) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      box.scrollTop = target;
      return;
    }
    const dur = Math.min(450, 120 + Math.abs(diff) * 0.35);
    const t0 = performance.now();
    const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / dur);
      lrcLastAuto = performance.now();
      box.scrollTop = start + diff * ease(p);
      if (p < 1) lrcScrollRaf = requestAnimationFrame(step);
    };
    lrcScrollRaf = requestAnimationFrame(step);
  }

  function updateLyrics(): void {
    const lines = lrcLines();
    if (!lines.length) return;
    const pos = player().position;
    let cur = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].t <= pos) cur = i;
      else break;
    }
    // Nothing moved — don't restart anything on the 500ms poll.
    const prev = activeIdx();
    if (cur === prev) return;
    // classList on each .lrc-line is reactive — this signal alone
    // repaints the active line, no imperative class juggling needed
    setActiveIdx(cur);

    // keep the active line centered without scrolling unless it drifts
    // out of the band — most line-to-line advances never scroll
    const el = lineEls[cur];
    if (!el) return;
    const bigJump = prev < 0 || cur - prev > 2;
    const elTop = el.offsetTop - box.offsetTop;
    const elBottom = elTop + el.offsetHeight;
    const center = box.scrollTop + box.clientHeight / 2;
    const band = box.clientHeight * 0.22;
    const inView = elTop >= center - band && elBottom <= center + band;
    if (bigJump || !inView) {
      const max = Math.max(0, box.scrollHeight - box.clientHeight);
      const target = Math.min(max, Math.max(0, elTop - box.clientHeight / 2 + el.offsetHeight / 2));
      if (bigJump) {
        lrcLastAuto = performance.now();
        box.scrollTop = target;
      } else {
        lrcScrollTo(target);
      }
    }
  }

  async function loadLyrics(): Promise<void> {
    const t = player().current;
    // guard against out-of-order async resolution when tracks change fast:
    // only the latest request is allowed to write
    const req = ++lrcReq;
    // drop refs to the previous track's lines — if the new lyrics are
    // shorter, the tail used to keep referencing detached DOM nodes
    // (audit B14, minor leak)
    lineEls.length = 0;
    if (!t) {
      setActiveIdx(-1);
      setLrcLines([]);
      setPlainText("No track playing.");
      return;
    }
    setPlainText(null);
    setLrcLines([]);
    setActiveIdx(-1);
    try {
      const raw = await invoke<string | null>("get_lyrics", {
        trackId: t.id,
        title: t.title,
        artist: t.artist,
        duration: t.duration,
      });
      if (req !== lrcReq) return;
      if (!raw) {
        setPlainText("No lyrics found for this track.");
        return;
      }
      const parsed = parseLrc(raw);
      if (req !== lrcReq) return;
      if (parsed.plain === null && parsed.lines.length > 0) {
        setLrcLines(parsed.lines);
        setPlainText(null);
        setActiveIdx(-1);
      } else {
        setLrcLines([]);
        setActiveIdx(-1);
        setPlainText(parsed.plain ?? "No lyrics found for this track.");
      }
    } catch {
      if (req !== lrcReq) return;
      setPlainText("No lyrics found for this track.");
    }
  }

  // Load when the panel opens. loadLyrics() reads player().current
  // synchronously — untrack it, or the whole player object becomes a
  // dependency and lyrics reload (clearing + refetching) on every poll.
  createEffect(() => {
    if (lyricsOpen()) void untrack(loadLyrics);
  });
  // reload when the track changes while open.
  // currentId is a DEDUPED memo — on() alone would refire on every poll
  // because it re-runs whenever any read signal writes, value or not.
  createEffect(
    on(currentId, () => {
      if (lyricsOpen()) void untrack(loadLyrics);
    })
  );
  // follow the position (poll cadence) while open
  createEffect(() => {
    if (!lyricsOpen()) return;
    void player().position;
    queueMicrotask(updateLyrics);
  });
  // an in-flight auto-scroll must not keep running after the panel
  // closes (audit P5)
  createEffect(
    on(lyricsOpen, (open) => {
      if (!open) cancelAnimationFrame(lrcScrollRaf);
    })
  );
  // leaving fullscreen re-syncs the scroll position
  createEffect(
    on(lyricsFs, (fs, prev) => {
      if (prev !== undefined && !fs) queueMicrotask(updateLyrics);
    })
  );

  // stop auto-scrolling the instant the user grabs the scrollbar
  const onBoxScroll = () => {
    if (performance.now() - lrcLastAuto > 50) cancelAnimationFrame(lrcScrollRaf);
  };
  onCleanup(() => cancelAnimationFrame(lrcScrollRaf));

  return (
    <aside id="lyrics-panel" class="drawer" classList={{ open: lyricsOpen(), fs: lyricsFs() }}>
      <div class="drawer-head">
        <span class="section-label">Lyrics</span>
        <div class="drawer-actions">
          <button
            id="btn-lyrics-fs"
            class="tbtn"
            title="Fullscreen"
            onClick={() => setLyricsFs(!lyricsFs())}
          >
            <Ico node={Maximize} cls="icon-fs-max" size={15} hidden={lyricsFs()} />
            <Ico node={Minimize} cls="icon-fs-min" size={15} hidden={!lyricsFs()} />
          </button>
          <button
            id="btn-lyrics-close"
            class="tbtn"
            title="Close"
            onClick={() => {
              if (lyricsFs()) setLyricsFs(false);
              setLyricsOpen(false);
            }}
          >
            <Ico node={X} size={15} />
          </button>
        </div>
      </div>
      <div class="drawer-body">
        <div ref={box} id="lyrics-text" class="lyrics-text" onScroll={onBoxScroll}>
          <For each={lrcLines()}>
            {(l, i) => (
              <div
                ref={(el) => (lineEls[i()] = el)}
                class="lrc-line"
                classList={{ active: activeIdx() === i() }}
                data-t={l.t}
              >
                {l.text || "♪"}
              </div>
            )}
          </For>
          {lrcLines().length === 0
            ? (plainText() ?? "Loading…")
            : ""}
        </div>
      </div>
    </aside>
  );
}
