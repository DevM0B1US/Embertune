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
      <div class="lib-bar">
        <span class="lib-bar-title">{libTitle()}</span>
        <div class="lib-bar-controls">
          <input
            ref={searchInp}
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
            onClick={() => {
              setFavOnly(!favOnly());
              invalidateView(true);
            }}
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
  );
}
