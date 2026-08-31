import { invoke } from "@tauri-apps/api/core";
import { createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import {
  Pause,
  Play,
  Repeat,
  Shuffle,
  SkipBack,
  SkipForward,
  Music2,
} from "lucide";
import { Ico } from "../lib/icons";
import { fmtDur } from "../lib/format";
import { artCache, cacheArt } from "../lib/state/library";
import { currentId, player, setPlayer } from "../lib/state/player";
import { toast } from "../lib/state/ui";
import type { SeekTarget } from "../lib/types";

const REPEAT_NEXT: Record<string, string> = { off: "all", all: "one", one: "off" };
const SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

export default function Player() {
  let nowEl!: HTMLDivElement;
  let nowTitle!: HTMLSpanElement;
  let nowArtist!: HTMLSpanElement;
  let nowArtImg!: HTMLImageElement;
  let thumbFallback!: HTMLDivElement;
  let timeCur!: HTMLSpanElement;
  let seekFill!: HTMLDivElement;
  let seekKnob!: HTMLDivElement;
  let seekInput!: HTMLInputElement;
  let volInput!: HTMLInputElement;

  // ── seek — adaptive rAF: 60fps only while playing/seeking ─────────
  let seekTarget: SeekTarget | null = null;
  let seekBase = { pos: 0, at: 0 };
  let visualPos = 0;
  let frameRaf = 0;
  let lastFillPct = -1;
  let lastTimeLabel = "";

  function setSeekVis(pct: number): void {
    const v = Math.max(0, Math.min(100, pct));
    seekFill.style.transform = `scaleX(${v / 100})`;
    seekKnob.style.left = `${v}%`;
  }

  function frameSeek(): void {
    const now = Date.now();
    const st = seekTarget;
    const seeking = !!st && now - st.at < 800;
    const shouldRun = seeking || (player().playing && player().duration > 0);
    if (!shouldRun || document.hidden) {
      // idle/hidden: check again in 250ms instead of 16ms — saves wakeups
      frameRaf = window.setTimeout(frameSeek, 250) as unknown as number;
      return;
    }
    let target: number;
    if (seeking && st) {
      target = st.secs;
    } else {
      target = seekBase.pos + ((now - seekBase.at) / 1000) * player().speed;
      if (target > player().duration) target = player().duration;
    }
    if (player().duration > 0) {
      const lerp = seeking ? 0.5 : 0.3;
      visualPos += (target - visualPos) * lerp;
      const pct = (visualPos / player().duration) * 100;
      if (Math.abs(pct - lastFillPct) > 0.05) {
        lastFillPct = pct;
        setSeekVis(pct);
      }
      if (document.activeElement !== seekInput) {
        seekInput.value = String(Math.min(1000, (pct / 100) * 1000));
      }
      const label = fmtDur(seeking && st ? st.secs : visualPos);
      if (label !== lastTimeLabel) {
        lastTimeLabel = label;
        timeCur.textContent = label;
      }
    }
    frameRaf = requestAnimationFrame(frameSeek);
  }

  onMount(() => {
    frameRaf = requestAnimationFrame(frameSeek);
    onCleanup(() => {
      cancelAnimationFrame(frameRaf);
      clearTimeout(frameRaf);
    });
  });

  // kick the visual loop when playback starts (poll drives this)
  createEffect(() => {
    if (player().playing) kickFrameSeek();
  });
  function kickFrameSeek(): void {
    if (!frameRaf) frameRaf = requestAnimationFrame(frameSeek);
  }

  // ── marquee for long now-playing lines (ported verbatim) ──────────
  function applyMarquee(el: HTMLElement, text: string): void {
    if (el.getAttribute("data-txt") === text) return;
    el.setAttribute("data-txt", text);
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

  // deduped memos — plain on(getter) would refire every poll
  const nowTitleText = createMemo(() => player().current?.title ?? "—");
  const nowArtistText = createMemo(() => player().current?.artist ?? "");
  createEffect(on(nowTitleText, (t) => applyMarquee(nowTitle, t)));
  createEffect(on(nowArtistText, (a) => applyMarquee(nowArtist, a)));

  const onWinResize = () => {
    for (const el of [nowTitle, nowArtist]) {
      el.removeAttribute("data-txt");
      applyMarquee(el, el.textContent || "");
    }
  };
  window.addEventListener("resize", onWinResize);
  onCleanup(() => window.removeEventListener("resize", onWinResize));

  // ── now-playing art + entrance replay ─────────────────────────────
  const [art, setArt] = createSignal<string | null>(null);

  // keyed on track id — the poll replaces the whole player state every
  // cycle, so effects must not re-fire unless the track actually changed
  createEffect(
    on(
      currentId,
      (id) => {
        if (id === null) {
          setArt(null);
          return;
        }
        const cached = artCache.get(id);
        if (cached) {
          setArt(cached);
          return;
        }
        void (async () => {
          try {
            const p = await invoke<string | null>("get_art", { trackId: id });
            if (p) {
              cacheArt(id, p);
              setArt(p);
            } else {
              setArt(null);
            }
          } catch {
            setArt(null);
          }
        })();
      }
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

  // ── transport actions ─────────────────────────────────────────────
  const toggleShuffle = () => {
    const on = !(player().shuffle || false);
    void invoke("set_shuffle", { on });
    setPlayer((p) => ({ ...p, shuffle: on }));
    toast(on ? "Shuffle on" : "Shuffle off");
  };

  const cycleRepeat = () => {
    const next = REPEAT_NEXT[player().repeat || "off"] || "off";
    void invoke("set_repeat", { mode: next });
    setPlayer((p) => ({ ...p, repeat: next }));
  };

  const cycleSpeed = () => {
    const cur = player().speed || 1.0;
    const idx = SPEEDS.findIndex((s) => Math.abs(s - cur) < 0.001);
    const next = SPEEDS[(idx + 1) % SPEEDS.length]!;
    void invoke("set_speed", { speed: next });
    setPlayer((p) => ({ ...p, speed: next }));
  };

  const speedLabel = () => {
    const v = player().speed || 1.0;
    return Number.isInteger(v) ? `${v}.0×` : `${v}×`;
  };

  const totalLabel = () => fmtDur(player().duration);

  return (
    <footer id="player" classList={{ playing: player().playing }}>
      <div ref={nowEl} id="now">
        <div class="thumb">
          <img
            ref={nowArtImg}
            id="now-art-img"
            class="thumb-img"
            classList={{ hidden: !art() }}
            src={art() ?? undefined}
            alt=""
            onError={() => setArt(null)}
          />
          <div ref={thumbFallback} class="thumb-fallback" classList={{ hidden: !!art() }}>
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
            classList={{ active: !!player().shuffle }}
            onClick={toggleShuffle}
          >
            <Ico node={Shuffle} size={15} />
          </button>
          <button id="btn-prev" class="tbtn" title="Previous" onClick={() => void invoke("player_prev")}>
            <Ico node={SkipBack} size={16} />
          </button>
          <button id="btn-play" class="tbtn" title="Play / Pause" onClick={() => void invoke("toggle_play")}>
            <Ico node={Play} cls="icon-play" size={18} hidden={player().playing} />
            <Ico node={Pause} cls="icon-pause" size={18} hidden={!player().playing} />
          </button>
          <button id="btn-next" class="tbtn" title="Next" onClick={() => void invoke("player_next")}>
            <Ico node={SkipForward} size={16} />
          </button>
          <button
            id="btn-repeat"
            class="tbtn"
            classList={{ active: (player().repeat || "off") !== "off" }}
            title={
              player().repeat === "one"
                ? "Repeat: one"
                : player().repeat === "all"
                  ? "Repeat: all"
                  : "Repeat: off"
            }
            data-mode={player().repeat || "off"}
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
              onInput={() => {
                const v = Number(seekInput.value);
                const pct = v / 10;
                seekTarget = { pct, secs: (player().duration * v) / 1000, at: Date.now() };
                setSeekVis(pct);
              }}
              onChange={() => {
                const v = Number(seekInput.value);
                const pct = v / 10;
                const st = { pct, secs: (player().duration * v) / 1000, at: Date.now() };
                seekTarget = st;
                setSeekVis(pct);
                void invoke("player_seek", { secs: st.secs });
              }}
            />
          </div>
          <span id="time-total" class="time-label">
            {totalLabel()}
          </span>
        </div>
      </div>

      <div class="player-right">
        <button id="btn-speed" class="tbtn speed-btn" title="Playback speed" onClick={cycleSpeed}>
          {speedLabel()}
        </button>
        <input
          ref={volInput}
          type="range"
          id="volume"
          min="0"
          max="100"
          value="100"
          title="Volume"
          onInput={() => void invoke("player_set_volume", { volume: Number(volInput.value) })}
        />
      </div>
    </footer>
  );
}
