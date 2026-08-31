import { invoke } from "@tauri-apps/api/core";
import { batch, createMemo, createRoot, createSignal } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import type { Track } from "../types";

// ═══════════════════════════════════════════════════════════════════
//  Library store — tracks, filters, derived views, artwork cache.
//
//  `viewItems` is a pure memo (tracks + search + fav + sort). Identity
//  of the visible sequence is exposed as `viewKey` so the list can
//  replay its entrance cascade / scroll-reset ONLY when what the user
//  sees actually changed — background library refreshes that resolve
//  to the same sequence are free.
// ═══════════════════════════════════════════════════════════════════

export type SortKey = "newest" | "title" | "artist" | "duration";

const libraryOwner = createRoot(() => {
  // ── data ──────────────────────────────────────────────────────────
  const [tracks, setTracks] = createSignal<Track[]>([]);

  // ── filters ───────────────────────────────────────────────────────
  const [searchTerm, setSearchTerm] = createSignal("");
  const [favOnly, setFavOnly] = createSignal(false);
  const [sortBy, setSortBy] = createSignal<SortKey>("newest");

  // One-shot flag consumed by the list on the next visible-sequence
  // change: filter interactions scroll back to top, background
  // refreshes keep the reading position. Filter actions below pair
  // the flag with the signal write inside a batch — outside a Solid
  // handler (e.g. a debounce timer) writes flush effects immediately,
  // so the flag MUST change in the same batch as the filter.
  let scrollResetPending = false;

  function applySearch(term: string): void {
    batch(() => {
      setSearchTerm(term);
      scrollResetPending = true;
    });
  }

  function applyFavFilter(on: boolean): void {
    batch(() => {
      setFavOnly(on);
      scrollResetPending = true;
    });
  }

  function applySort(key: SortKey): void {
    batch(() => {
      setSortBy(key);
      scrollResetPending = true;
    });
  }

  const takeScrollReset = (): boolean => {
    const r = scrollResetPending;
    scrollResetPending = false;
    return r;
  };

  // lowercase haystack index — rebuilt only when the library changes,
  // never per keystroke
  const hayIndex = createMemo(() =>
    tracks().map((t) => ({
      t,
      hay: `${t.title} ${t.artist} ${t.album}`.toLowerCase(),
    }))
  );

  const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

  const viewItems = createMemo<Track[]>(() => {
    const fav = favOnly();
    const q = searchTerm() ? searchTerm().toLowerCase() : "";
    let out: Track[];
    if (!fav && !q) {
      out = tracks();
    } else {
      out = [];
      for (const { t, hay } of hayIndex()) {
        if (fav && !t.favorite) continue;
        if (q && !hay.includes(q)) continue;
        out.push(t);
      }
    }
    switch (sortBy()) {
      case "title":
        return out.slice().sort((a, b) => collator.compare(a.title, b.title));
      case "artist":
        return out.slice().sort((a, b) => collator.compare(a.artist, b.artist));
      case "duration":
        return out.slice().sort((a, b) => a.duration - b.duration);
      default:
        return out.slice().sort((a, b) => b.added_at - a.added_at);
    }
  });

  /** Stable identity of the visible sequence (ids in display order). */
  const viewKey = createMemo(() => {
    let k = "";
    for (const t of viewItems()) k += `${t.id},`;
    return k;
  });

  const totalCount = createMemo(() => tracks().length);
  const libTitle = createMemo(() => {
    const total = totalCount();
    const shown = viewItems().length;
    if (total === 0) return "Library";
    return shown === total
      ? `Library · ${total.toLocaleString()}`
      : `${shown.toLocaleString()} / ${total.toLocaleString()}`;
  });

  // ── artwork cache (shared with the player bar) ────────────────────
  const artCache = new Map<number, string>();

  function cacheArt(id: number, path: string): void {
    if (artCache.size >= 160) {
      const oldest = artCache.keys().next().value;
      if (oldest !== undefined) artCache.delete(oldest);
    }
    artCache.set(id, path);
  }

  // ── actions ───────────────────────────────────────────────────────
  /** Reuse previous track objects when nothing changed so rows are not
   *  recreated (no flash) on no-op library refreshes. */
  function mergeTracks(prev: Track[], next: Track[]): Track[] {
    if (prev.length === 0) return next;
    const byId = new Map(prev.map((t) => [t.id, t]));
    return next.map((t) => {
      const old = byId.get(t.id);
      return old && sameTrack(old, t) ? old : t;
    });
  }

  function sameTrack(a: Track, b: Track): boolean {
    return (
      a.title === b.title &&
      a.artist === b.artist &&
      a.album === b.album &&
      a.duration === b.duration &&
      a.path === b.path &&
      a.source === b.source &&
      a.source_url === b.source_url &&
      a.added_at === b.added_at &&
      a.favorite === b.favorite
    );
  }

  async function refreshLibrary(): Promise<void> {
    const fresh = await invoke<Track[]>("get_library");
    setTracks((prev) => mergeTracks(prev, fresh));
  }

  function applyFavorite(id: number, favorite: boolean): void {
    setTracks((prev) => prev.map((t) => (t.id === id ? { ...t, favorite } : t)));
  }

  /** Optimistic favorite toggle with rollback on failure. Mutating the
   *  store immutably keeps `viewItems` correct in favorites-only mode. */
  async function setTrackFavorite(track: Track): Promise<void> {
    const next = !track.favorite;
    applyFavorite(track.id, next);
    try {
      await invoke("set_favorite", { id: track.id, favorite: next });
    } catch {
      applyFavorite(track.id, !next);
    }
  }

  return {
    tracks,
    setTracks,
    searchTerm,
    favOnly,
    sortBy,
    applySearch,
    applyFavFilter,
    applySort,
    takeScrollReset,
    viewItems,
    viewKey,
    totalCount,
    libTitle,
    artCache,
    cacheArt,
    refreshLibrary,
    setTrackFavorite,
  };
});

export const tracks = libraryOwner.tracks;
export const searchTerm = libraryOwner.searchTerm;
export const favOnly = libraryOwner.favOnly;
export const sortBy = libraryOwner.sortBy;
export const applySearch = libraryOwner.applySearch;
export const applyFavFilter = libraryOwner.applyFavFilter;
export const applySort = libraryOwner.applySort;
export const takeScrollReset = libraryOwner.takeScrollReset;
export const viewItems = libraryOwner.viewItems;
export const viewKey = libraryOwner.viewKey;
export const totalCount = libraryOwner.totalCount;
export const libTitle = libraryOwner.libTitle;
export const artCache = libraryOwner.artCache;
export const cacheArt = libraryOwner.cacheArt;
export const refreshLibrary = libraryOwner.refreshLibrary;
export const setTrackFavorite = libraryOwner.setTrackFavorite;

/** Subscribe to backend library change events. */
export function initLibraryEvents(): () => void {
  const unsubs: Array<() => void> = [];
  void listen("library-changed", () => {
    void refreshLibrary();
  }).then((u) => unsubs.push(u));
  return () => unsubs.forEach((u) => u());
}
