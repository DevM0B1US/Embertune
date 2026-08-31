import { createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { Music2, Pause, Play, Repeat, Shuffle, SkipBack, SkipForward } from "lucide";
import { Ico } from "../lib/icons";
import { fmtDur } from "../lib/format";
import { artCache, cacheArt } from "../lib/state/library";
import {
  currentId,
  currentTrack,
  cycleRepeat,
  cycleSpeed,
  duration,
  isPlaying,
  nextTrack,
  position,
  prevTrack,
  repeat,
  seekTo,
  setVolume,
  shuffle,
  speed,
  togglePlay,
  toggleShuffle,
  volume,
} from "../lib/state/player";
import { invoke } from "@tauri-apps/api/core";
import type { SeekTarget } from "../lib/types";

// ── marquee for long now-playing lines ──────────────────────────────
// Builds a two-copy sliding track when the text overflows; otherwise
// leaves plain text. The source string is always passed in — never
// read back from the DOM (a marquee element holds two copies).
function applyMarquee(el: HTMLElement, text: string): void {
  if (el.dataset.txt === text) return;
  el.dataset.txt = text;
  el.classList.remove("marquee");
  el.textContent = text;
  if (el.scrollWidth <= el.clientWidth + 2) return;
  el.classList.add("marquee");
  const track = document.createElement("span");
  track.className = "m-track";
  for (let i = 0; i < 2; i++) {
    const copy = document.createElement("span");
    copy.className = "m-copy";
    copy.textContent = text;
    track.appendChild(copy);
  }
  el.replaceChildren(track);
  const secs = Math.min(24, Math.max(6, text.length * 0.2));
  track.style.animationDuration = `${secs}s`;
}

export default function Player() {
  let nowEl!: HTMLDivElement;
  let nowTitle!: HTMLSpanElement;
  let nowArtist!: HTMLSpanElement;
  let timeCur!: HTMLSpanElement;
  let seekFill!: HTMLDivElement;
  let seekKnob!: HTMLDivElement;
  let seekInput!: HTMLInputElement;
  let volInput!: HTMLInputElement;

  // ── seek visuals — this loop is the single writer to the seek UI ──
  // `sync` is the last authoritative (poll) position with its wall
  // clock stamp; between polls the position is advanced by elapsed
  // real time so the bar moves at 60fps without poll-driven jumps.
  let sync = { pos: 0, at: performance.now() };
  let seekTarget: SeekTarget | null = null;
  let visualPos = 0;
  let rafId = 0;
  let lastFillPct = -1;
  let lastLabel = "";

  // poll positions land here; a big jump (track change, keyboard seek,
  // drag release) snaps the visual immediately instead of lerping
  createEffect(
    on(position, (pos) => {
      sync = { pos, at: performance.now() };
      if (Math.abs(pos - visualPos) > 1.5) visualPos = pos;
    })
  );

  function paintSeek(pct: number): void {
    seekFill.style.transform = `scaleX(${pct / 100})`;
    seekKnob.style.left = `${pct}%`;
  }

  function frame(): void {
    rafId = 0;
    if (document.hidden) return; // visibilitychange restarts the loop
    const st = seekTarget;
    const seeking = !!st && Date.now() - st.at < 800;
    const playing = isPlaying();
    if (!playing && !seeking) return; // nothing to animate — loop stops

    const dur = duration();
    if (dur > 0) {
      let target: number;
      if (seeking && st) {
        target = st.secs;
      } else {
        const elapsed = (performance.now() - sync.at) / 1000;
        target = Math.min(dur, sync.pos + elapsed * speed());
      }
      const lerp = seeking ? 0.5 : 0.3;
      visualPos += (target - visualPos) * lerp;
      const pct = (visualPos / dur) * 100;
      if (Math.abs(pct - lastFillPct) > 0.05) {
        lastFillPct = pct;
        paintSeek(pct);
      }
      if (document.activeElement !== seekInput) {
        seekInput.value = String(Math.min(1000, Math.round((pct / 100) * 1000)));
      }
      const label = fmtDur(seeking && st ? st.secs : visualPos);
      if (label !== lastLabel) {
        lastLabel = label;
        timeCur.textContent = label;
      }
    }
    rafId = requestAnimationFrame(frame);
  }

  function kick(): void {
    if (!rafId) rafId = requestAnimationFrame(frame);
  }

  // restart the visual loop when playback starts, after seeking, or
  // when the window becomes visible again — otherwise it stays asleep
  createEffect(() => {
    if (isPlaying()) kick();
  });
  const onVisibility = (): void => {
    if (!document.hidden && isPlaying()) kick();
  };
  document.addEventListener("visibilitychange", onVisibility);
  onCleanup(() => {
    document.removeEventListener("visibilitychange", onVisibility);
    cancelAnimationFrame(rafId);
  });

  // ── marquee wiring ─────────────────────────────────────────────────
  const nowTitleText = createMemo(() => currentTrack()?.title ?? "—");
  const nowArtistText = createMemo(() => currentTrack()?.artist ?? "");
  createEffect(on(nowTitleText, (t) => applyMarquee(nowTitle, t)));
  createEffect(on(nowArtistText, (a) => applyMarquee(nowArtist, a)));

  const reapplyMarquees = (): void => {
    nowTitle.removeAttribute("data-txt");
    applyMarquee(nowTitle, nowTitleText());
    nowArtist.removeAttribute("data-txt");
    applyMarquee(nowArtist, nowArtistText());
  };
  window.addEventListener("resize", reapplyMarquees);
  onCleanup(() => window.removeEventListener("resize", reapplyMarquees));

  // ── now-playing art ────────────────────────────────────────────────
  const [art, setArt] = createSignal<string | null>(null);

  // keyed on the deduped track id; cache hits apply synchronously so
  // the previous track's art never lingers during a switch
  createEffect(
    on(
      currentId,
      (id) => {
        if (id === null) {
          setArt(null);
          return;
        }
        const cached = artCache.get(id);
        setArt(cached ?? null);
        if (cached) return;
        void (async () => {
          try {
            const p = await invoke<string | null>("get_art", { trackId: id });
            if (p) {
              cacheArt(id, p);
              if (currentId() === id) setArt(p);
            } else {
              setArt(null);
            }
          } catch {
            setArt(null);
          }
        })();
      },
      { defer: true }
    )
  );

  // entrance animation when the track changes
  createEffect(
    on(currentId, () => {
      nowEl.classList.remove("now-in");
      void nowEl.offsetWidth;
      nowEl.classList.add("now-in");
    })
  );

  // ── volume slider sync (guarded while the user is on it) ──────────
  const [volumeBusy, setVolumeBusy] = createSignal(false);
  createEffect(() => {
    const v = volume();
    if (!volumeBusy() && document.activeElement !== volInput) {
      volInput.value = String(v);
    }
  });

  const onSeekInput = (): void => {
    const v = Number(seekInput.value);
    const pct = v / 10;
    seekTarget = { pct, secs: (duration() * v) / 1000, at: Date.now() };
    paintSeek(pct);
    const label = fmtDur(seekTarget.secs);
    if (label !== lastLabel) {
      lastLabel = label;
      timeCur.textContent = label;
    }
    kick();
  };

  const onSeekChange = (): void => {
    const v = Number(seekInput.value);
    const pct = v / 10;
    const st = { pct, secs: (duration() * v) / 1000, at: Date.now() };
    seekTarget = st;
    paintSeek(pct);
    seekTo(st.secs);
    kick();
  };

  const repeatTitle = () =>
    repeat() === "one" ? "Repeat: one" : repeat() === "all" ? "Repeat: all" : "Repeat: off";

  const speedText = createMemo(() => {
    const v = speed() || 1.0;
    return Number.isInteger(v) ? `${v}.0×` : `${v}×`;
  });

  onMount(() => {
    // let CSS variables settle before measuring overflow on first paint
    queueMicrotask(reapplyMarquees);
  });

  return (
    <footer id="player" classList={{ playing: isPlaying() }}>
      <div ref={nowEl} id="now">
        <div class="thumb">
          <img
            id="now-art-img"
            class="thumb-img"
            classList={{ hidden: !art() }}
            src={art() ?? undefined}
            alt=""
            onError={() => setArt(null)}
          />
          <div class="thumb-fallback" classList={{ hidden: !!art() }}>
            <Ico node={Music2} size={18} />
          </div>
          <div class="eq-bars" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        </div>
        <div class="now-text">
          <span ref={nowTitle} id="now-title" class="now-line" />
          <span ref={nowArtist} id="now-artist" class="now-line" />
        </div>
      </div>

      <div class="player-center">
        <div class="transport">
          <button
            id="btn-shuffle"
            class="tbtn"
            title="Shuffle"
            classList={{ active: shuffle() }}
            onClick={toggleShuffle}
          >
            <Ico node={Shuffle} size={15} />
          </button>
          <button id="btn-prev" class="tbtn" title="Previous" onClick={prevTrack}>
            <Ico node={SkipBack} size={16} />
          </button>
          <button id="btn-play" class="tbtn" title="Play / Pause" onClick={togglePlay}>
            <Ico node={Play} cls="icon-play" size={18} hidden={isPlaying()} />
            <Ico node={Pause} cls="icon-pause" size={18} hidden={!isPlaying()} />
          </button>
          <button id="btn-next" class="tbtn" title="Next" onClick={nextTrack}>
            <Ico node={SkipForward} size={16} />
          </button>
          <button
            id="btn-repeat"
            class="tbtn"
            classList={{ active: repeat() !== "off" }}
            title={repeatTitle()}
            data-mode={repeat()}
            onClick={cycleRepeat}
          >
            <Ico node={Repeat} size={15} />
          </button>
        </div>

        <div class="progress-row">
          <span ref={timeCur} id="time-cur" class="time-label">
            0:00
          </span>
          <div class="seek-wrap">
            <div class="seek-vis">
              <div ref={seekFill} id="seek-fill" />
            </div>
            <div ref={seekKnob} id="seek-knob" />
            <input
              ref={seekInput}
              type="range"
              id="seek"
              min="0"
              max="1000"
              value="0"
              onInput={onSeekInput}
              onChange={onSeekChange}
            />
          </div>
          <span id="time-total" class="time-label">
            {fmtDur(duration())}
          </span>
        </div>
      </div>

      <div class="player-right">
        <button id="btn-speed" class="tbtn speed-btn" title="Playback speed" onClick={cycleSpeed}>
          {speedText()}
        </button>
        <input
          ref={volInput}
          type="range"
          id="volume"
          min="0"
          max="100"
          value={volume()}
          title="Volume"
          onPointerDown={() => setVolumeBusy(true)}
          onPointerUp={() => setVolumeBusy(false)}
          onBlur={() => setVolumeBusy(false)}
          onInput={() => setVolume(Number(volInput.value))}
        />
      </div>
    </footer>
  );
}
