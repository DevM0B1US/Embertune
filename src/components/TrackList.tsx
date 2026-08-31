import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount } from "solid-js";
import TrackRow, { markColdRender, notifyScrollActivity } from "./TrackRow";
import { takeScrollReset, viewItems, viewKey } from "../lib/state/library";
import { dlList } from "../lib/state/downloads";
import type { Track } from "../lib/types";

// ═══════════════════════════════════════════════════════════════════
//  TrackList — windowed virtualization for the library.
//
//  · Fixed row height (self-healed by measuring a real row) keeps the
//    index math pixel-exact at any library size.
//  · #track-list is position:relative with an explicit height; rows
//    are absolutely positioned <li>s translated with translate3d().
//  · The window memo slices the visible range (+BUFFER rows on each
//    side) driven by an rAF-coalesced scroll signal; Solid's <For>
//    diffs the slice by track identity — only rows entering/leaving
//    the window are created or destroyed, middle rows are untouched.
//  · Track objects are reference-stable across refreshes (the library
//    store merges unchanged tracks), so scrolling, filtering and
//    background refreshes never recreate rows wholesale — no flashing.
//  · Entrance cascades replay only when the visible id sequence
//    actually changes (viewKey); rows mounted by scrolling run a short
//    batch-anchored micro-cascade (≤120ms, see TrackRow).
// ═══════════════════════════════════════════════════════════════════

const BUFFER = 10; // extra rows rendered above/below the viewport
const DEFAULT_ROW_H = 56; // mirrors --row-h; replaced by a real measure

export default function TrackList(props: { viewEl: HTMLElement }) {
  let listEl!: HTMLUListElement;

  const [rowH, setRowH] = createSignal(DEFAULT_ROW_H);
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportH, setViewportH] = createSignal(0);
  const [mounted, setMounted] = createSignal(false);

  let lastKey = "";

  const win = createMemo(() => {
    const items = viewItems();
    const key = viewKey(); // dependency — marks the cascade below
    if (!mounted()) return { start: 0, slice: [] as Track[] };
    const rh = rowH();
    const total = items.length;
    const top = Math.max(0, scrollTop() - listEl.offsetTop);
    const start = Math.max(0, Math.floor(top / rh) - BUFFER);
    const end = Math.min(total, Math.ceil((top + viewportH()) / rh) + BUFFER);
    // memos run before effects/render effects: the cascade marker is
    // set before any newly created row mounts
    if (key !== lastKey) {
      lastKey = key;
      markColdRender();
    }
    return { start, slice: items.slice(start, end) };
  });

  onMount(() => {
    const view = props.viewEl;
    setMounted(true);
    setViewportH(view.clientHeight);

    // ── scroll → rAF-coalesced window updates + art-load gating ────
    let rafPending = false;
    const onScroll = () => {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        notifyScrollActivity();
        setScrollTop(view.scrollTop);
      });
    };
    view.addEventListener("scroll", onScroll, { passive: true });
    onCleanup(() => view.removeEventListener("scroll", onScroll));

    // ── viewport resizes (window, zoom, panel toggles) ─────────────
    const ro = new ResizeObserver(() => setViewportH(view.clientHeight));
    ro.observe(view);
    onCleanup(() => ro.disconnect());

    // downloads panel show/hide shifts the list's offsetTop — resync
    createEffect(() => {
      dlList().length;
      setScrollTop(view.scrollTop);
    });

    // keep row height in sync with CSS (zoom / DPR changes)
    const adoptRowHeight = (): void => {
      const li = listEl.querySelector(".track") as HTMLElement | null;
      const h = li?.getBoundingClientRect().height ?? 0;
      if (h > 8 && Math.abs(h - rowH()) > 0.5) setRowH(h);
    };

    // visible-sequence change: reset to top when the change came from
    // a filter interaction (never from a background refresh)
    createEffect(
      on(viewKey, () => {
        if (takeScrollReset()) {
          view.scrollTop = 0;
          setScrollTop(0);
        }
        adoptRowHeight();
      })
    );

    queueMicrotask(adoptRowHeight);
  });

  return (
    <ul ref={listEl} id="track-list" style={{ height: `${viewItems().length * rowH()}px` }}>
      <For each={win().slice}>
        {(track, index) => (
          <TrackRow
            track={track}
            index={index}
            start={() => win().start}
            rowH={rowH}
            viewEl={props.viewEl}
          />
        )}
      </For>
    </ul>
  );
}
