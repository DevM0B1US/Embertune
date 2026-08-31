import { createRoot, createSignal } from "solid-js";
import type { Track } from "../types";
import { sndClose, sndOpen } from "../sounds";

// ═══════════════════════════════════════════════════════════════════
//  UI store — overlays (settings / lyrics / meta), toast, prompt
//  dialog, and small UI services (search focus).
// ═══════════════════════════════════════════════════════════════════

export interface PromptOptions {
  message?: string;
  initial?: string;
  okText?: string;
}

export interface PromptState {
  open: boolean;
  confirm: boolean;
  title: string;
  msg: string;
  showMsg: boolean;
  showInput: boolean;
  initial: string;
  okText: string;
}

const uiOwner = createRoot(() => {
  // ── overlays ──────────────────────────────────────────────────────
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [lyricsOpen, setLyricsOpen] = createSignal(false);
  const [lyricsFs, setLyricsFs] = createSignal(false);
  const [metaOpen, setMetaOpen] = createSignal(false);
  const [metaTrack, setMetaTrack] = createSignal<Track | null>(null);

  function toggleSettings(): void {
    setSettingsOpen((o) => !o);
    if (settingsOpen()) sndOpen();
    else sndClose();
  }

  function closeSettings(): void {
    if (settingsOpen()) sndClose();
    setSettingsOpen(false);
  }

  function setLyricsFullscreen(on: boolean): void {
    setLyricsFs(on);
    if (on) sndOpen();
    else sndClose();
  }

  function toggleLyrics(): void {
    const open = !lyricsOpen();
    setLyricsOpen(open);
    if (open) sndOpen();
    else sndClose();
  }

  function openMeta(track: Track): void {
    setMetaTrack(track);
    setMetaOpen(true);
    sndOpen();
  }

  function closeMeta(): void {
    setMetaOpen(false);
    sndClose();
  }

  // ── prompt / confirm dialog ───────────────────────────────────────
  const [prompt, setPrompt] = createSignal<PromptState>({
    open: false,
    confirm: false,
    title: "",
    msg: "",
    showMsg: false,
    showInput: true,
    initial: "",
    okText: "OK",
  });

  // element refs registered by PromptDialog (focus management)
  const promptRefs: { input?: HTMLInputElement; ok?: HTMLButtonElement } = {};

  let promptResolve: ((v: string | null) => void) | null = null;

  function finishPrompt(value: string | null): void {
    if (prompt().open) sndClose();
    setPrompt((p) => ({ ...p, open: false }));
    if (promptResolve) {
      const resolve = promptResolve;
      promptResolve = null;
      resolve(value);
    }
  }

  function promptDialog(title: string, opts: PromptOptions = {}): Promise<string | null> {
    // a second prompt while one is open must not orphan the first
    // caller's promise (audit B8) — resolve it as if it was dismissed
    if (promptResolve) {
      const pending = promptResolve;
      promptResolve = null;
      pending(null);
    }
    setPrompt({
      open: true,
      confirm: false,
      title,
      msg: opts.message ?? "",
      showMsg: !!opts.message,
      showInput: true,
      initial: opts.initial ?? "",
      okText: opts.okText ?? "OK",
    });
    return new Promise((resolve) => {
      promptResolve = resolve;
      queueMicrotask(() => {
        // set imperatively so re-opening with the same initial never
        // shows stale typed text
        if (promptRefs.input) promptRefs.input.value = opts.initial ?? "";
        promptRefs.input?.focus();
        promptRefs.input?.select();
      });
    });
  }

  function confirmDialog(message: string, okText = "Delete"): Promise<boolean> {
    // same double-open guard as promptDialog (audit B8)
    if (promptResolve) {
      const pending = promptResolve;
      promptResolve = null;
      pending(null);
    }
    setPrompt({
      open: true,
      confirm: true,
      title: "Confirm",
      msg: message,
      showMsg: true,
      showInput: false,
      initial: "",
      okText,
    });
    sndOpen();
    return new Promise((resolve) => {
      promptResolve = (v) => resolve(v !== null);
      queueMicrotask(() => {
        // clear the input in confirm mode so a stale value can never
        // make "Delete" resolve against old text
        if (promptRefs.input) promptRefs.input.value = "";
        promptRefs.ok?.focus();
      });
    });
  }

  // ── toast ─────────────────────────────────────────────────────────
  const [toastState, setToastState] = createSignal<{
    text: string;
    hidden: boolean;
    leaving: boolean;
  }>({ text: "", hidden: true, leaving: false });

  const toastRefs: { el?: HTMLElement } = {};
  let toastTimer: number | undefined;
  let toastLeaveTimer: number | undefined;

  function toast(msg: string): void {
    setToastState({ text: msg, hidden: false, leaving: false });
    const el = toastRefs.el;
    if (el) void el.offsetWidth; // restart the entry animation
    window.clearTimeout(toastTimer);
    window.clearTimeout(toastLeaveTimer);
    toastTimer = window.setTimeout(() => {
      setToastState((s) => ({ ...s, leaving: true }));
      toastLeaveTimer = window.setTimeout(
        () => setToastState((s) => ({ ...s, hidden: true })),
        220
      );
    }, 3500);
  }

  // ── small UI services ─────────────────────────────────────────────
  const uiRefs: { search?: HTMLInputElement } = {};
  const registerSearchInput = (el: HTMLInputElement): void => {
    uiRefs.search = el;
  };
  const focusSearch = (): void => {
    uiRefs.search?.focus();
  };

  return {
    settingsOpen,
    setSettingsOpen,
    toggleSettings,
    closeSettings,
    lyricsOpen,
    setLyricsOpen,
    lyricsFs,
    setLyricsFs,
    setLyricsFullscreen,
    toggleLyrics,
    metaOpen,
    setMetaOpen,
    metaTrack,
    setMetaTrack,
    openMeta,
    closeMeta,
    prompt,
    setPrompt,
    promptRefs,
    finishPrompt,
    promptDialog,
    confirmDialog,
    toastState,
    toastRefs,
    toast,
    registerSearchInput,
    focusSearch,
  };
});

export const settingsOpen = uiOwner.settingsOpen;
export const setSettingsOpen = uiOwner.setSettingsOpen;
export const toggleSettings = uiOwner.toggleSettings;
export const closeSettings = uiOwner.closeSettings;
export const lyricsOpen = uiOwner.lyricsOpen;
export const setLyricsOpen = uiOwner.setLyricsOpen;
export const lyricsFs = uiOwner.lyricsFs;
export const setLyricsFs = uiOwner.setLyricsFs;
export const setLyricsFullscreen = uiOwner.setLyricsFullscreen;
export const toggleLyrics = uiOwner.toggleLyrics;
export const metaOpen = uiOwner.metaOpen;
export const setMetaOpen = uiOwner.setMetaOpen;
export const metaTrack = uiOwner.metaTrack;
export const setMetaTrack = uiOwner.setMetaTrack;
export const openMeta = uiOwner.openMeta;
export const closeMeta = uiOwner.closeMeta;
export const prompt = uiOwner.prompt;
export const setPrompt = uiOwner.setPrompt;
export const promptRefs = uiOwner.promptRefs;
export const finishPrompt = uiOwner.finishPrompt;
export const promptDialog = uiOwner.promptDialog;
export const confirmDialog = uiOwner.confirmDialog;
export const toastState = uiOwner.toastState;
export const toastRefs = uiOwner.toastRefs;
export const toast = uiOwner.toast;
export const registerSearchInput = uiOwner.registerSearchInput;
export const focusSearch = uiOwner.focusSearch;

// DEV-only test hook (audit TE1): lets Playwright drive the dialog store
// directly. Tree-shaken from production builds via import.meta.env.DEV.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__embertuneUi = {
    promptDialog: uiOwner.promptDialog,
    confirmDialog: uiOwner.confirmDialog,
    finishPrompt: uiOwner.finishPrompt,
  };
}
