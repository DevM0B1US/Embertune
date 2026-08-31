import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount } from "solid-js";
import TrackRow from "./TrackRow";
import { useRowFx } from "./rowfx";
import { takeScrollReset, viewItems, viewKey } from "../lib/state/library";
import { dlList } from "../lib/state/downloads";
import { playTrack, togglePlay } from "../lib/state/player";
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
//    actually changes (viewKey); rows mounted by scrolling run a
//    continuous per-gesture ripple (≤120ms cap, see TrackRow/rowfx).
//  · Keyboard navigation (audit U1) + ARIA listbox semantics (audit
//    U2): the list is focusable, ↑/↓/PgUp/PgDn/Home/End move a
//    selection that is kept centered, Enter/Space play it. The
//    selected row is highlighted exactly like a hovered row, so the
//    list's appearance is untouched until the user actually navigates.
// ═══════════════════════════════════════════════════════════════════

const BUFFER = 10; // extra rows rendered above/below the viewport
const DEFAULT_ROW_H = 56; // mirrors --row-h; replaced by a real measure

export default function TrackList(props: { viewEl: HTMLElement }) {
  let listEl!: HTMLUListElement;
  const fx = useRowFx();

  const [rowH, setRowH] = createSignal(DEFAULT_ROW_H);
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportH, setViewportH] = createSignal(0);
  const [mounted, setMounted] = createSignal(false);
  // keyboard-selected track id (null = nothing selected yet)
  const [selId, setSelId] = createSignal<number | null>(null);

  let lastKey = "";

  // ⚠ DELIBERATE SIDE EFFECT IN A MEMO (audit B15) — read before touching:
  // `win` is the one place that knows a new window diff is about to hit the
  // DOM. Memos run synchronously during propagation, BEFORE render effects
  // and before <For> mounts the new rows — which is exactly when the cold
  // cascade marker must be set so the first freshly-mounted row anchors the
  // stagger. Moving markColdRender() into an effect (createEffect / Render
  // effect) would run AFTER the rows mount and the anchor would be one row
  // late (or the whole cascade would read as stale). If you ever need this
  // memo to be pure, the marker must move into the row-mount path itself,
  // not into another effect.
  const win = createMemo(() => {
    const items = viewItems();
    const key = viewKey(); // dependency — marks the cascade above
    if (!mounted()) return { start: 0, slice: [] as Track[] };
    const rh = rowH();
    const total = items.length;
    const top = Math.max(0, scrollTop() - listEl.offsetTop);
    const start = Math.max(0, Math.floor(top / rh) - BUFFER);
    const end = Math.min(total, Math.ceil((top + viewportH()) / rh) + BUFFER);
    if (key !== lastKey) {
      lastKey = key;
      fx.markColdRender();
    }
    return { start, slice: items.slice(start, end) };
  });

  // ── keyboard navigation (audit U1) ────────────────────────────────
  const rowById = createMemo(() => new Map(viewItems().map((t) => [t.id, t])));
  const itemIndex = createMemo(() => new Map(viewItems().map((t, i) => [t.id, i])));

  function moveSelection(delta: number): void {
    const items = viewItems();
    if (items.length === 0) return;
    const cur = selId();
    const idx = cur !== null ? (itemIndex().get(cur) ?? -1) : -1;
    const next = Math.max(0, Math.min(items.length - 1, idx + delta));
    const t = items[next]!;
    setSelId(t.id);
    // keep the selected row centered — through the container's own scroll
    // pipeline so the scrollbar, ripple and smoothwheel stay in sync
    const top = next * rowH() - viewportH() / 2 + rowH() / 2;
    props.viewEl.scrollTo({ top: Math.max(0, top) });
  }

  const onListKeyDown = (e: KeyboardEvent): void => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveSelection(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveSelection(-1);
        break;
      case "PageDown":
        e.preventDefault();
        moveSelection(Math.max(1, Math.floor(viewportH() / rowH()) - 1));
        break;
      case "PageUp":
        e.preventDefault();
        moveSelection(-Math.max(1, Math.floor(viewportH() / rowH()) - 1));
        break;
      case "Home":
        e.preventDefault();
        moveSelection(-viewItems().length);
        break;
      case "End":
        e.preventDefault();
        moveSelection(viewItems().length);
        break;
      case "Enter":
      case " ": {
        const id = selId();
        if (id !== null && rowById().has(id)) {
          e.preventDefault();
          playTrack(id);
        } else {
          e.preventDefault();
          togglePlay();
        }
        break;
      }
    }
  };

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
        fx.notifyScrollActivity();
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
    <ul
      ref={listEl}
      id="track-list"
      role="listbox"
      aria-label="Library tracks"
      tabIndex={0}
      aria-activedescendant={selId() !== null ? `track-row-${selId()}` : undefined}
      onKeyDown={onListKeyDown}
      style={{ height: `${viewItems().length * rowH()}px` }}
    >
      <For each={win().slice}>
        {(track, index) => (
          <TrackRow
            track={track}
            index={index}
            start={() => win().start}
            rowH={rowH}
            viewEl={props.viewEl}
            selected={() => selId() === track.id}
          />
        )}
      </For>
    </ul>
  );
}
