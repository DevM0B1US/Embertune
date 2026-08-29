import { invoke } from "@tauri-apps/api/core";
import { $, instantClose, sndOpen, sndClose } from "./lib";

// 10-band graphic EQ. Frequencies must match EQ_FREQS in player.rs.
const FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;
const GAIN_MIN = -12;
const GAIN_MAX = 12;

const PRESETS: Record<string, number[]> = {
  flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  bass: [7, 5, 3, 1, 0, 0, 0, 0, 0, 0],
  treble: [0, 0, 0, 0, 0, 2, 4, 6, 6, 6],
  pop: [-2, -1, 1, 2, 3, 3, 4, 4, 3, 2],
  rock: [5, 4, 3, 2, 1, 2, 3, 4, 4, 3],
  vocal: [1, 2, 3, 3, 4, 5, 4, 3, 2, 1],
};

let bands = [...PRESETS.flat];
let sendTimer: number | undefined;

function sendBands(): void {
  window.clearTimeout(sendTimer);
  sendTimer = window.setTimeout(() => {
    void invoke("set_eq_bands", { bands });
  }, 180);
}

function setBand(i: number, v: number): void {
  bands[i] = v;
  renderBar(i);
  syncPills();
  sendBands();
}

function renderBar(i: number): void {
  const col = document.querySelector<HTMLElement>(`.eq-col[data-band="${i}"]`);
  if (!col) return;
  const g = bands[i];
  const bar = col.querySelector<HTMLElement>(".eq-bar")!;
  const val = col.querySelector<HTMLElement>(".eq-gain")!;
  const slider = col.querySelector<HTMLInputElement>(".eq-slider")!;
  const stage = col.querySelector<HTMLElement>(".eq-stage")!;
  slider.value = String(g);
  const half = stage.clientHeight / 2;
  const h = (Math.abs(g) / GAIN_MAX) * half;
  if (g >= 0) {
    bar.style.top = "auto";
    bar.style.bottom = "50%";
    bar.style.height = `${h}px`;
    bar.classList.remove("neg");
  } else {
    bar.style.top = "50%";
    bar.style.bottom = "auto";
    bar.style.height = `${h}px`;
    bar.classList.add("neg");
  }
  val.textContent = g > 0 ? `+${g}` : String(g);
}

function syncPills(): void {
  document.querySelectorAll<HTMLElement>("#eq-pills .pill").forEach((p) => {
    const preset = PRESETS[p.dataset.eq || ""];
    const active = !!preset && preset.every((v, i) => v === bands[i]);
    p.classList.toggle("active", active);
  });
}

function applyPreset(key: string): void {
  bands = [...PRESETS[key]];
  bands.forEach((_, i) => renderBar(i));
  syncPills();
  sendBands();
}

function buildBars(): void {
  const wrap = $("#eq-bars");
  wrap.innerHTML = "";
  FREQS.forEach((f, i) => {
    const col = document.createElement("div");
    col.className = "eq-col";
    col.dataset.band = String(i);
    col.innerHTML = `
      <span class="eq-gain">0</span>
      <div class="eq-stage">
        <div class="eq-zero"></div>
        <div class="eq-bar"></div>
        <input class="eq-slider" type="range" min="${GAIN_MIN}" max="${GAIN_MAX}" step="1" value="0" />
      </div>
      <span class="eq-freq">${f >= 1000 ? `${f / 1000}k` : f}</span>
    `;
    col
      .querySelector<HTMLInputElement>(".eq-slider")!
      .addEventListener("input", (e) => {
        setBand(i, parseInt((e.target as HTMLInputElement).value, 10));
      });
    wrap.appendChild(col);
  });
  bands.forEach((_, i) => renderBar(i));
}

export function initEqualizer(): void {
  buildBars();

  $("#eq-pills").addEventListener("click", (e) => {
    const pill = (e.target as HTMLElement).closest<HTMLElement>(".pill");
    if (!pill || !pill.dataset.eq) return;
    applyPreset(pill.dataset.eq);
  });

  $("#btn-eq").addEventListener("click", () => {
    const p = $("#eq-panel");
    const open = p.classList.toggle("open");
    if (open) {
      sndOpen();
      $("#btn-eq").classList.add("active");
      instantClose($("#queue-panel"), $("#btn-queue"));
      instantClose($("#lyrics-panel"), $("#btn-lyrics"));
      $("#playlists-menu").classList.add("hidden");
    } else {
      sndClose();
      $("#btn-eq").classList.remove("active");
    }
  });

  $("#btn-eq-close").addEventListener("click", () => {
    sndClose();
    $("#eq-panel").classList.remove("open");
    $("#btn-eq").classList.remove("active");
  });

  void invoke<{ eq_bands?: number[] }>("get_settings").then((s) => {
    if (s.eq_bands && s.eq_bands.length === FREQS.length) {
      bands = s.eq_bands.map((v) => Math.round(v));
    }
    bands.forEach((_, i) => renderBar(i));
    syncPills();
  });
}