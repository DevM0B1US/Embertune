import { invoke } from "@tauri-apps/api/core";
import {
  For,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import { Heart, Pencil, Play, Trash2 } from "lucide";
import { Ico } from "../lib/icons";
import { fmtDur } from "../lib/format";
import { attachSmoothWheel } from "../smoothwheel";
import {
  artCache,
  cacheArt,
  confirmDialog,
  consumeReset,
  dlList,
  favOnly,
  invalidateView,
  openMeta,
  playHi,
  playTrack,
  refreshLibrary,
  viewGen,
  viewItems,
} from "../lib/state";
import type { Track } from "../lib/types";

// ═══════════════════════════════════════════════════════════════════
//  Virtualized library list — SolidJS port
//
//  Same architecture as the vanilla engine, now declarative:
//  · Fixed row height (--row-h mirrored in a signal, self-healed by
//    measuring a real row) — index math stays pixel-exact at 50k+.
//  · #track-list is position:relative with an explicit height; rows
//    are absolutely positioned <li>s translated with translate3d().
//  · The window memo slices the visible range; Solid's keyed <For>
//    diffs it — only rows entering/leaving the window are created or
//    destroyed, identical to the old incremental Map diff. Middle rows
//    keep their DOM node, and their absolute index (start + index)
//    never changes on shift, so their transform writes are no-ops.
//  · Entrance animations: WAAPI fade+slide. A viewGen bump (search /
//    sort / fav / refresh) recreates every row → the capped 24ms/row
//    cascade plays again, exactly like the old cold render. Rows that
//    enter while scrolling get the 150ms micro-stagger, skipped
//    during flings (>4px/ms) and under prefers-reduced-motion.
//  · Stale-artwork-on-pooled-rows is structurally impossible: rows
//    are never pooled — each creation starts from a fresh <img>.
// ═══════════════════════════════════════════════════════════════════

const BUFFER = 8; // extra rows rendered above/below the viewport
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");

// module-level perf vars (shared between the window memo and rows)
let lastGen = -1;
let coldAt = -1e9;
let coldStart = 0;
let batchN = 0;
let lastVel = 0;
let prevScrollTop = -1;
let prevFlushAt = performance.now();

// ── entrance animation (WAAPI — no class juggling, no reflows) ──────
function animateIn(trow: HTMLElement, delay: number, quick: boolean): void {
  if (typeof trow.animate !== "function") return;
  trow.animate(
    [
      { opacity: "0", transform: "translateY(7px)" },
      { opacity: "1", transform: "translateY(0)" },
    ],
    {
      duration: quick ? 150 : 280,
      delay,
      easing: quick ? "ease-out" : "cubic-bezier(0.22, 1, 0.36, 1)",
      fill: "backwards",
    }
  );
}

// ── artwork: one shared IntersectionObserver, preloads 600px ahead ──
type ArtLoader = () => void;
let artObserver: IntersectionObserver | null = null;
const artLoaders = new Map<HTMLElement, ArtLoader>();

function ensureObserver(root: HTMLElement): IntersectionObserver {
  if (artObserver) return artObserver;
  artObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        artObserver!.unobserve(e.target);
        artLoaders.get(e.target as HTMLElement)?.();
      }
    },
    { root, rootMargin: "600px 0px", threshold: 0 }
  );
  return artObserver;
}

async function loadArt(t: Track, setArt: (s: string) => void): Promise<void> {
  const cached = artCache.get(t.id);
  if (cached) {
    setArt(cached);
    return;
  }
  try {
    const p = await invoke<string | null>("get_art", { trackId: t.id });
    if (p) {
      cacheArt(t.id, p);
      setArt(p);
    }
  } catch {
    /* no art */
  }
}

// ── favorites / delete (row actions) ────────────────────────────────
async function toggleFav(t: Track, setFav: (v: boolean) => void): Promise<void> {
  const before = t.favorite;
  t.favorite = !before; // master object — future filters see it
  setFav(!before); // instant visual
  try {
    await invoke("set_favorite", { id: t.id, favorite: t.favorite });
  } catch {
    t.favorite = before;
    setFav(before);
    return;
  }
  // in favorites-only mode the row must leave/enter the list
  if (favOnly()) invalidateView(false);
}

async function deleteTrack(t: Track): Promise<void> {
  if (!(await confirmDialog(`Delete "${t.title}" from the library and disk?`, "Delete"))) return;
  await invoke("remove_track", { id: t.id });
  await refreshLibrary();
}

// ── one row ─────────────────────────────────────────────────────────
function TrackRow(props: {
  item: { g: number; t: Track };
  indexAccessor: () => number;
  start: () => number;
  rowH: () => number;
  viewEl: HTMLElement;
}) {
  const t = props.item.t;
  let li!: HTMLLIElement;
  const [fav, setFav] = createSignal(t.favorite);
  const [art, setArt] = createSignal<string | null>(artCache.get(t.id) ?? null);
  const absIdx = () => props.start() + props.indexAccessor();

  onMount(() => {
    // entrance animation — cold cascade vs scroll-in micro-stagger
    const trow = li.firstElementChild as HTMLElement | null;
    if (trow && !REDUCED_MOTION.matches && typeof li.animate === "function") {
      if (performance.now() - coldAt < 400) {
        animateIn(trow, Math.min((absIdx() - coldStart) * 24, 340), false);
      } else if (lastVel < 4) {
        animateIn(trow, Math.min(batchN++ * 12, 72), true);
      }
    }

    // artwork — lazy via shared observer unless already cached
    if (!art()) {
      const loader = () => void loadArt(t, setArt);
      artLoaders.set(li, loader);
      ensureObserver(props.viewEl).observe(li);
      onCleanup(() => {
        artLoaders.delete(li);
        artObserver?.unobserve(li);
      });
    }
  });

  return (
    <li
      ref={li}
      class="track"
      data-id={t.id}
      classList={{
        playing: playHi().id === t.id,
        paused: playHi().id === t.id && !playHi().playing,
      }}
      style={{ transform: `translate3d(0, ${absIdx() * props.rowH()}px, 0)` }}
      onClick={(e) => {
        const target = e.target as HTMLElement;
        if (!target.closest(".row-actions")) playTrack(t.id);
      }}
    >
      <div class="trow">
        <button
          class="play-btn"
          title="Play"
          aria-label="Play"
          onClick={(e) => {
            e.stopPropagation();
            playTrack(t.id);
          }}
        >
          <Ico node={Play} size={13} cls="row-play-icon" />
        </button>
        <img
          class="track-art"
          classList={{ hidden: !art() }}
          src={art() ?? undefined}
          alt=""
          draggable={false}
          loading="lazy"
          onError={(e) => {
            setArt(null);
            (e.currentTarget as HTMLImageElement).removeAttribute("src");
          }}
        />
        <div class="track-meta">
          <div class="track-title" title={t.artist ? `${t.title} — ${t.artist}` : t.title}>
            {t.title}
          </div>
          <div class="track-sub">
            {t.artist || "—"} · {fmtDur(t.duration)}
          </div>
        </div>
        <span class="track-src">{t.source}</span>
        <div class="row-actions">
          <button
            class="heart-btn"
            classList={{ fav: fav() }}
            title="Favorite"
            aria-label="Favorite"
            onClick={(e) => {
              e.stopPropagation();
              void toggleFav(t, setFav);
            }}
          >
            <Ico node={Heart} size={13} fill={fav() ? "currentColor" : "none"} />
          </button>
          <button
            class="edit-btn"
            title="Edit"
            aria-label="Edit"
            onClick={(e) => {
              e.stopPropagation();
              openMeta(t);
            }}
          >
            <Ico node={Pencil} size={13} />
          </button>
          <button
            class="del-btn"
            title="Delete"
            aria-label="Delete"
            onClick={(e) => {
              e.stopPropagation();
              void deleteTrack(t);
            }}
          >
            <Ico node={Trash2} size={14} />
          </button>
        </div>
      </div>
    </li>
  );
}

// ── the list itself ─────────────────────────────────────────────────
export default function TrackList(props: { viewEl: HTMLElement }) {
  let listEl!: HTMLUListElement;
  const [rowH, setRowH] = createSignal(56);
  const [scrollY, setScrollY] = createSignal(0);
  // createMemo evaluates eagerly during render — before refs bind.
  // This flag becomes a dependency so the window recomputes on mount.
  const [mounted, setMounted] = createSignal(false);

  const win = createMemo(() => {
    const g = viewGen();
    const items = viewItems();
    const rh = rowH();
    if (!mounted() || !listEl) return { g, start: 0, slice: [] as Track[] };
    const total = items.length;
    const top = scrollY();
    const listTop = listEl.offsetTop;
    const vh = props.viewEl.clientHeight;
    const start = Math.max(0, Math.floor((top - listTop) / rh) - BUFFER);
    const end = Math.min(total, Math.ceil((top + vh - listTop) / rh) + BUFFER);
    if (g !== lastGen) {
      lastGen = g;
      coldAt = performance.now();
      coldStart = start;
    }
    batchN = 0;
    return { g, start, slice: items.slice(start, end) };
  });

  // wrappers give <For> a fresh identity per generation → a gen bump
  // recreates every row (cold cascade); within a generation refs are
  // stable → scrolling only creates/destroys edge rows
  const wrapped = createMemo(() => {
    const w = win();
    return w.slice.map((t) => ({ g: w.g, t }));
  });

  onMount(() => {
    const view = props.viewEl;
    setMounted(true);
    let rafPending = false;

    const onScroll = () => {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        const st = view.scrollTop;
        const now = performance.now();
        const dt = now - prevFlushAt;
        lastVel = prevScrollTop >= 0 && dt > 0 ? Math.abs(st - prevScrollTop) / dt : 0;
        prevScrollTop = st;
        prevFlushAt = now;
        setScrollY(st);
      });
    };
    view.addEventListener("scroll", onScroll, { passive: true });
    onCleanup(() => view.removeEventListener("scroll", onScroll));

    // buttery wheel scrolling for WebKitGTK chunky wheel steps
    const detachWheel = attachSmoothWheel(view);
    onCleanup(detachWheel);

    // downloads panel toggling shifts the list's offsetTop — resync
    createEffect(() => {
      dlList().length;
      setScrollY(view.scrollTop);
    });

    // keep ROW_H in sync with CSS (zoom, DPR, media queries)
    const adoptRowHeight = () => {
      const li = listEl.querySelector(".track") as HTMLElement | null;
      const h = li?.getBoundingClientRect().height ?? 0;
      if (h > 8 && Math.abs(h - rowH()) > 0.5) {
        setRowH(h);
        document.documentElement.style.setProperty("--row-h", `${h}px`);
      }
    };
    let resizeTimer: number | undefined;
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        setScrollY(view.scrollTop); // recompute window for new viewport size
        adoptRowHeight();
      }, 150);
    };
    window.addEventListener("resize", onResize);
    onCleanup(() => window.removeEventListener("resize", onResize));

    // one-shot self-heal after each cold render (a real row now exists);
    // scroll reset (search/sort/fav) happens on the same tick
    createEffect(
      on(viewGen, () => {
        adoptRowHeight();
        if (consumeReset()) view.scrollTop = 0;
      })
    );

    adoptRowHeight();
  });

  return (
    <ul ref={listEl} id="track-list" style={{ height: `${viewItems().length * rowH()}px` }}>
      <For each={wrapped()}>
        {(item, indexAccessor) => (
          <TrackRow
            item={item}
            indexAccessor={indexAccessor}
            start={() => win().start}
            rowH={rowH}
            viewEl={props.viewEl}
          />
        )}
      </For>
    </ul>
  );
}
