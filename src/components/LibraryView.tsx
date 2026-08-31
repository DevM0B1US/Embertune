import { Heart } from "lucide";
import { onCleanup } from "solid-js";
import TrackList from "./TrackList";
import DownloadsPanel from "./DownloadsPanel";
import { Ico } from "../lib/icons";
import {
  favOnly,
  libTitle,
  searchTerm,
  setSearchTerm,
  setFavOnly,
  setSortBy,
  sortBy,
  totalCount,
  viewItems,
  requestScrollReset,
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
  let searchInp!: HTMLInputElement;
  let searchDebounce: number | undefined;
  onCleanup(() => clearTimeout(searchDebounce));

  const onSearchInput = () => {
    clearTimeout(searchDebounce);
    searchDebounce = window.setTimeout(() => {
      const next = searchInp.value.trim();
      if (next === searchTerm()) return;
      setSearchTerm(next);
      requestScrollReset();
    }, 120);
  };

  const cycleSort = () => {
    const idx = SORTS.findIndex(([k]) => k === sortBy());
    const next = SORTS[(idx + 1) % SORTS.length]!;
    setSortBy(next[0]);
    requestScrollReset();
  };

  const sortLabel = () => SORTS.find(([k]) => k === sortBy())?.[1] || "Newest";

  return (
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
            onClick={() => {
              setFavOnly(!favOnly());
              requestScrollReset();
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
