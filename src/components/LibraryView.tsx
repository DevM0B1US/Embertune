import { Heart } from "lucide";
import { onCleanup } from "solid-js";
import TrackList from "./TrackList";
import DownloadsPanel from "./DownloadsPanel";
import { Ico } from "../lib/icons";
import {
  dlList,
  favOnly,
  invalidateView,
  libTitle,
  searchTerm,
  setFavOnly,
  setSearchTerm,
  setSortBy,
  sortBy,
  totalCount,
  viewItems,
} from "../lib/state";

const SORTS: Array<[string, string]> = [
  ["newest", "Newest"],
  ["title", "A–Z"],
  ["artist", "Artist"],
  ["duration", "Dur"],
];

export default function LibraryView() {
  let viewEl!: HTMLElement;
  let searchInp!: HTMLInputElement;
  let searchDebounce: number | undefined;
  onCleanup(() => clearTimeout(searchDebounce));

  // search — debounced 120ms, identical to the vanilla build
  const onSearchInput = () => {
    clearTimeout(searchDebounce);
    searchDebounce = window.setTimeout(() => {
      const next = searchInp.value.trim();
      if (next === searchTerm()) return;
      setSearchTerm(next);
      invalidateView(true);
    }, 120);
  };

  const cycleSort = () => {
    const idx = SORTS.findIndex(([k]) => k === sortBy());
    const next = SORTS[(idx + 1) % SORTS.length]!;
    setSortBy(next[0]);
    invalidateView(true);
  };

  const sortLabel = () => SORTS.find(([k]) => k === sortBy())?.[1] || "Newest";

  return (
    <section id="view-library" class="view" ref={viewEl}>
      <div class="view-head">
        <span id="lib-title" class="section-label">
          {libTitle()}
        </span>
        <div class="lib-actions">
          <input
            ref={searchInp}
            id="search"
            type="text"
            placeholder="Search…"
            spellcheck={false}
            onInput={onSearchInput}
          />
          <button
            id="btn-sort"
            class="tbtn sort-btn"
            title={`Sort: ${sortLabel()}`}
            data-sort={sortBy()}
            onClick={cycleSort}
          >
            {sortLabel()}
          </button>
          <button
            id="btn-fav"
            class="tbtn topbtn"
            title="Favorites only"
            aria-label="Favorites only"
            classList={{ active: favOnly() }}
            onClick={() => {
              setFavOnly(!favOnly());
              invalidateView(true);
            }}
          >
            <Ico node={Heart} size={16} />
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
  );
}
