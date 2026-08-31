import { createEffect, createMemo, createSignal, For, on, onCleanup, untrack } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { Maximize, Minimize, X } from "lucide";
import { Ico } from "../lib/icons";
import { parseLrc, type LrcLine } from "../lib/lrc";
import { player } from "../lib/state/player";
import { lyricsFs, lyricsOpen, setLyricsFs, setLyricsOpen } from "../lib/state/ui";

// ── lyrics parsing lives in lib/lrc.ts (unit-tested) ───────────────

export default function LyricsPanel() {
  let box!: HTMLDivElement;
  const [lrcLines, setLrcLines] = createSignal<LrcLine[]>([]);
  const [plainText, setPlainText] = createSignal<string | null>(null);
  const [activeIdx, setActiveIdx] = createSignal(-1);
  const [loaded, setLoaded] = createSignal(false);

  // row elements captured via refs — no per-line DOM queries
  let lineEls: HTMLElement[] = [];

  let lrcReq = 0;
  let lrcScrollRaf = 0;
  let lrcLastAuto = 0;
  let lrcTarget = -1;
  // auto-follow pauses briefly after the user scrolls the panel
  // themselves, so it doesn't drag them back mid-read (Spotify-style)
  let followPausedUntil = 0;
  const FOLLOW_PAUSE_MS = 4000;

  // ── interpolated playback clock ───────────────────────────────────
  // get_player_state only rewrites state every 500ms while playing, so
  // driving the highlight from raw poll positions makes it trail up to
  // half a second behind the song. Anchor on the latest poll and
  // extrapolate locally between polls instead.
  let clockPos = 0;
  let clockAt = 0;
  let clockPlaying = false;
  let clockSpeed = 1;

  function nowPos(): number {
    if (!clockPlaying) return clockPos;
    return clockPos + ((performance.now() - clockAt) / 1000) * clockSpeed;
  }

  // re-anchor the clock on every poll write; runs unconditionally but
  // only writes four plain variables
  createEffect(() => {
    const ps = player();
    clockPos = ps.position;
    clockAt = performance.now();
    clockPlaying = ps.playing;
    clockSpeed = ps.speed > 0 ? ps.speed : 1;
  });

  // rAF-driven scroll — native smooth gets restarted/stutters in WebKit
  // (prefers-reduced-motion, audit U5: no eased glide — jump straight)
  function lrcScrollTo(target: number): void {
    cancelAnimationFrame(lrcScrollRaf);
    const start = box.scrollTop;
    const diff = target - start;
    if (Math.abs(diff) < 1) {
      lrcTarget = -1;
      return;
    }
    lrcTarget = target;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      box.scrollTop = target;
      lrcTarget = -1;
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
      else lrcTarget = -1;
    };
    lrcScrollRaf = requestAnimationFrame(step);
  }

  function updateLyrics(): void {
    const lines = lrcLines();
    if (!lines.length) return;
    const pos = nowPos();
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
    // user is browsing — keep the highlight moving, pause the scrolling
    if (performance.now() < followPausedUntil) return;
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
        lrcTarget = -1;
        box.scrollTop = target;
      } else {
        // a glide already heading to this spot must not restart —
        // restarting resets its easing every poll and visibly pulses
        if (lrcTarget >= 0 && Math.abs(target - lrcTarget) < 4) return;
        lrcScrollTo(target);
      }
    }
  }

  // which track the visible content belongs to — reopening the panel
  // for the same track skips the fetch entirely (no clear + fade blink)
  let loadedForId: number | null | undefined;

  async function loadLyrics(): Promise<void> {
    const t = player().current;
    const id = t?.id ?? null;
    if (loadedForId === id) return;
    loadedForId = id;
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
      setLoaded(true);
      return;
    }
    setPlainText(null);
    setLrcLines([]);
    setActiveIdx(-1);
    setLoaded(false);
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
        setLoaded(true);
        return;
      }
      const parsed = parseLrc(raw);
      if (req !== lrcReq) return;
      if (parsed.plain === null && parsed.lines.length > 0) {
        setLrcLines(parsed.lines);
        setPlainText(null);
        setActiveIdx(-1);
        setLoaded(true);
        queueMicrotask(updateLyrics);
      } else {
        setLrcLines([]);
        setActiveIdx(-1);
        setPlainText(parsed.plain ?? "No lyrics found for this track.");
        setLoaded(true);
      }
    } catch {
      if (req !== lrcReq) return;
      setPlainText("No lyrics found for this track.");
      setLoaded(true);
    }
  }

  // The poll-confirmed track id, deduped: the raw `player` object is
  // replaced on EVERY poll (500ms while playing), so tracking player()
  // or player().current here re-ran loadLyrics — clear + refetch +
  // opacity fade — twice a second while the panel was open: the
  // "constantly flickering lyrics" bug. It also kept resetting the
  // highlight, which is why sync looked broken. A deduped memo stays
  // silent while nothing but the position changed.
  const backendTrackId = createMemo(() => player().current?.id ?? null);

  // Load when the panel opens; reload when the confirmed track changes.
  // If the panel opens before the first poll lands (first F press),
  // this fires again the moment backendTrackId goes null → id — no
  // retry timer needed.
  createEffect(() => {
    if (!lyricsOpen()) return;
    backendTrackId();
    void untrack(loadLyrics);
  });

  // follow the position while open — re-sync immediately on each poll
  // write; the 120ms ticker below covers the gaps between polls so the
  // highlight lands on the beat instead of trailing half a second
  createEffect(() => {
    if (!lyricsOpen()) return;
    void player();
    queueMicrotask(updateLyrics);
  });

  // highlight cadence between polls (interpolated clock) — updateLyrics
  // early-returns unless the active line actually changed
  let ticker = 0;
  const startTicker = (): void => {
    if (ticker) return;
    ticker = window.setInterval(() => {
      if (clockPlaying) updateLyrics();
    }, 120);
  };
  const stopTicker = (): void => {
    window.clearInterval(ticker);
    ticker = 0;
  };

  // ticker + scroll-anim lifecycle with the panel
  createEffect(
    on(lyricsOpen, (open) => {
      if (open) {
        followPausedUntil = 0;
        startTicker();
      } else {
        // an in-flight auto-scroll must not keep running after the panel
        // closes (audit P5)
        cancelAnimationFrame(lrcScrollRaf);
        lrcTarget = -1;
        stopTicker();
      }
    })
  );
  onCleanup(() => {
    stopTicker();
    cancelAnimationFrame(lrcScrollRaf);
  });
  // leaving fullscreen re-syncs the scroll position
  createEffect(
    on(lyricsFs, (fs, prev) => {
      if (prev !== undefined && !fs) queueMicrotask(updateLyrics);
    })
  );

  // stop auto-scrolling the instant the user grabs the scrollbar — and
  // pause auto-follow for a few seconds so it doesn't drag them back
  // mid-read; the highlight keeps tracking, only the scrolling pauses
  const onBoxScroll = () => {
    if (performance.now() - lrcLastAuto > 50) {
      cancelAnimationFrame(lrcScrollRaf);
      lrcTarget = -1;
      followPausedUntil = performance.now() + FOLLOW_PAUSE_MS;
    }
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
      <div class="drawer-body" style={{ opacity: loaded() ? 1 : 0, transition: "opacity 0.2s ease" }}>
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
          {lrcLines().length === 0 && plainText()
            ? plainText()
            : ""}
        </div>
      </div>
    </aside>
  );
}
