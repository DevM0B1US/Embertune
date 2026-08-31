import { Heart } from "lucide";
import { onCleanup, onMount } from "solid-js";
import TrackList from "./TrackList";
import DownloadsPanel from "./DownloadsPanel";
import { createRowFx, RowFxProvider } from "./rowfx";
import { Ico } from "../lib/icons";
import { attachOverlayScrollbar } from "../lib/scrollbar";
import { attachSmoothWheel } from "../smoothwheel";
import {
  applyFavFilter,
  applySearch,
  applySort,
  favOnly,
  libTitle,
  searchTerm,
  sortBy,
  totalCount,
  viewItems,
  type SortKey,
} from "../lib/state/library";
import { dlList } from "../lib/state/downloads";
import { registerSearchInput } from "../lib/state/ui";

const SORTS: Array<[SortKey, string]> = [
  ["newest", "Newest"],
  ["title", "A–Z"],
  ["artist", "Artist"],
  ["duration", "Dur"],
];

export default function LibraryView() {
  let viewEl!: HTMLElement;
  let thumbEl!: HTMLDivElement;
  let searchInp!: HTMLInputElement;
  let searchDebounce: number | undefined;
  onCleanup(() => clearTimeout(searchDebounce));

  // one effects instance per list (audit Q2/B4): owns the cascade state
  // and the artwork IntersectionObserver, and — crucially — disconnects
  // the observer when this view unmounts so a remount can never observe
  // against a stale detached root
  const fx = createRowFx();
  onCleanup(() => fx.dispose());

  onMount(() => {
    // inertial wheel scrolling (WebKitGTK notchy steps) + auto-fade
    // overlay scrollbar; the container stays the native scroller
    const detachWheel = attachSmoothWheel(viewEl);
    const detachScrollbar = attachOverlayScrollbar(viewEl, thumbEl);
    onCleanup(() => {
      detachWheel();
      detachScrollbar();
    });
  });

  const onSearchInput = () => {
    clearTimeout(searchDebounce);
    searchDebounce = window.setTimeout(() => {
      const next = searchInp.value.trim();
      if (next === searchTerm()) return;
      applySearch(next);
    }, 120);
  };

  const cycleSort = () => {
    const idx = SORTS.findIndex(([k]) => k === sortBy());
    const next = SORTS[(idx + 1) % SORTS.length]!;
    applySort(next[0]);
  };

  const sortLabel = () => SORTS.find(([k]) => k === sortBy())?.[1] || "Newest";

  return (
    <RowFxProvider value={fx}>
      <div class="view-shell">
      <section id="view-library" class="view" ref={viewEl}>
        <div class="lib-bar">
          <span class="lib-bar-title">{libTitle()}</span>
          <div class="lib-bar-controls">
            <input
              ref={(el) => {
                searchInp = el;
                registerSearchInput(el);
              }}
              id="search"
              class="lib-bar-search"
              type="text"
              placeholder="Search…"
              spellcheck={false}
              onInput={onSearchInput}
            />
            <button
              class="lib-bar-sort"
              title={`Sort: ${sortLabel()}`}
              data-sort={sortBy()}
              onClick={cycleSort}
            >
              {sortLabel()}
            </button>
            <button
              class="lib-bar-fav"
              title="Favorites only"
              aria-label="Favorites only"
              classList={{ active: favOnly() }}
              onClick={() => applyFavFilter(!favOnly())}
            >
              <Ico node={Heart} size={15} />
            </button>
          </div>
        </div>

        <DownloadsPanel />

        <TrackList viewEl={viewEl} />

        <div
          id="empty-library"
          class="empty"
          classList={{
            hidden: viewItems().length > 0 || dlList().length > 0,
          }}
        >
          {totalCount() === 0 ? "Nothing here yet. Drop a URL above." : "No matches."}
        </div>
      </section>
      <div ref={thumbEl} class="osb-thumb" />
      </div>
    </RowFxProvider>
  );
}
