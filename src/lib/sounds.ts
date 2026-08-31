// Tiny synthesized WebAudio pops; no assets, one shared context.
const sndState: { ctx: AudioContext | null } = { ctx: null };
const sndEnabled = localStorage.getItem("embertune.sound") !== "off";
const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function sndResume(): void {
  try {
    if (sndState.ctx) {
      if (sndState.ctx.state === "suspended") void sndState.ctx.resume();
      return;
    }
    sndState.ctx = new AudioContext();
  } catch {
    sndState.ctx = null;
  }
}

function blip(freq: number, dur: number, vol: number, type: OscillatorType = "sine"): void {
  if (!sndEnabled || prefersReduced) return;
  sndResume();
  const ctx = sndState.ctx;
  if (!ctx || ctx.state !== "running") return;
  try {
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(45, freq * 0.55), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + dur + 0.03);
  } catch {
    /* audio is best-effort */
  }
}

export const sndClick = (): void => blip(340, 0.05, 0.028, "triangle");
export const sndOpen = (): void => blip(460, 0.08, 0.04);
export const sndClose = (): void => blip(250, 0.07, 0.035);
export const sndDone = (): void => {
  blip(540, 0.08, 0.045);
  blip(820, 0.12, 0.03);
};
