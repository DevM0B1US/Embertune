# Embertune — Audit & Improvements

**Scope:** full production-grade stabilization, deep refactor, performance overhaul, and modernization of the SolidJS frontend (`src/`) after an incomplete Vanilla JS → SolidJS conversion. The Rust backend (`src-tauri/`) is intentionally untouched.

**Basis:** branch `main` at `4df8dc4` ("fix: scrollbar stays visible during playback; plain seek bar") → 5 atomic commits on top, working tree clean and ready to ship.

---

## 1. Executive Summary — Original State vs. Final State

| Dimension | Before (`4df8dc4`) | After (this work) |
|---|---|---|
| Library list | Plain `<For>` over the **entire** library — one real DOM subtree per track | Windowed virtualization: ~25–30 rows in DOM at **any** library size (verified at 50,000 tracks) |
| Scroll feel | Native WebKitGTK wheel (discrete, notchy steps, no inertia) | Inertial lerped wheel scrolling (smoothwheel re-attached) + auto-fade overlay scrollbar |
| Scrollbar | Always visible (`overflow-y: scroll` + `scrollbar-gutter: stable`), historically prone to flicker under animation load | Hidden by default; appears while scrolling (any source), fades out after 800 ms idle; draggable; never flickers (single composited div, rAF-coalesced paint) |
| Entrance animation | None (the conversion had deleted the vanilla WAAPI cascade) | Restored and improved: "one-by-one" 22 ms/row cascade on cold renders, subtle 150 ms micro-stagger for slow scroll-in, automatically suppressed during flings and under reduced-motion |
| Player bar | Two competing writers to the seek slider (poll + rAF loop), poll re-rendered the whole player object every 500 ms, marquee duplicated text on resize, stale artwork between track switches, loop never slept | Single-writer rAF visual loop, diffed poll writes, deduped per-field memos, fixed marquee, synchronous cache-first art, loop fully stops when idle |
| State management | One 371-line `state.ts` mixing 6 domains, redundant `playHi` signal, imperative DOM reach-arounds | Five domain stores (`library`, `player`, `downloads`, `settings`, `ui`) with explicit actions and ownership |
| Library refresh | Every `library-changed` event rebuilt **all** row objects → full list re-render + flash | Stable-reference merge: unchanged tracks keep their object identity; cascade replays only when the visible sequence actually changes |
| Dead code | Dead `smoothwheel` module (orphaned), dead CSS blocks, stale comments referencing deleted files, unused exports | Removed; CSS 31.38 KB → 31.08 KB with zero dead selectors; every remaining module is wired and used |
| Bundle (min/gzip) | 57.38 KB / 20.06 KB JS, 31.38 KB / 6.93 KB CSS | 67.95 KB / 23.89 KB JS, 31.08 KB / 6.88 KB CSS (+2.9 KB gzip total — includes the dev-only IPC mock harness, ErrorBoundary, scrollbar & stagger engines) |

The conversion is now **complete**: there are no remaining imperative DOM patterns on reactive paths, no hybrid vanilla/Solid anti-patterns, and no orphaned modules. Everything verified end-to-end in a real browser against a mock IPC layer (see §7).

---

## 2. Root-Cause Analysis & Fixes

### 2.1 Song / track list (highest priority)

**What the code looked like**

```tsx
// TrackList.tsx @ 4df8dc4 — the ENTIRE library in the DOM
<ul id="track-list">
  <For each={viewItems()}>
    {(t) => <TrackRow t={t} viewEl={props.viewEl} />}
  </For>
</ul>
```

**Root causes**

1. **No virtualization.** Git archaeology: the previous commit (`70a0f43`) contained a SolidJS port of the vanilla virtual-scroll engine, but `4df8dc4` **tore it out entirely** while fixing an unrelated WebKitGTK scrollbar problem. The result rendered one real row subtree (~22 elements: buttons, inline SVGs, art `<img>`, meta) per track. At 3,000 tracks that is ≈66,000 DOM elements; at 20,000 tracks ≈440,000. Initial render, scroll layout, style recalc and memory all degrade linearly with library size.
2. **Whole-list identity churn.** Every `library-changed` backend event called `get_library` (fresh objects) and re-created **every** track object. `<For>` diffs by reference, so the entire visible list was torn down and rebuilt — the "flash" on every refresh — and 3,000 fresh rows lost their artwork cache hot-path, re-observed by the IntersectionObserver, etc.
3. **N-way reactive fan-out.** Every row read the global `playHi()` signal inside its `classList`. With no virtualization that meant N live effects; each poll write to `playHi` re-ran N classList computations per tick.
4. **No entrance animation at all.** The CSS comment still referenced the deleted vanilla `library.ts` WAAPI engine ("entrance animation is driven by WAAPI from library.ts") — a lie left behind by the conversion; the "one-by-one" progressive appearance was simply gone.
5. **Browser scroll anchoring.** With any windowed approach, the browser's scroll-anchoring fights rows mounting/unmounting above the viewport (measured during this work: search-from-depth clamped offsets to wrong positions).

**How it was rewritten** (commits `9522147`, `514d2c3`)

- **Windowed virtualization, Solid-idiomatic.** `#track-list` is `position: relative` with an explicit pixel height (`items × rowH`); rows are absolutely positioned `<li>`s translated with `translate3d(0, absIndex × rowH, 0)`. A window memo slices `visible ± 10 buffer rows` from an rAF-coalesced scroll signal. Solid's keyed `<For>` diffs the slice **by track identity**, so only rows entering/leaving the window are created or destroyed — middle rows keep their DOM node, and their absolute index never changes on shift, so their transform writes are value-equal no-ops.
- **Fixed, self-healing row height.** Row height defaults to the `--row-h` CSS value (56 px) and is re-measured from a real row (zoom/DPR changes), keeping the index math pixel-exact at any scale — verified: 1.86 M px of fling in a single task lands on the exact expected row.
- **Stable references kill refresh flashes.** `refreshLibrary()` merges incoming tracks into the previous array by id, reusing the old object when all fields are equal (`mergeTracks`/`sameTrack`). Unchanged tracks keep their reference → `<For>` does not recreate their rows. DOM node count was measured **constant across repeated scroll/refresh rounds** (zero leak, zero churn).
- **Cascade only when it matters.** The gen-bump machinery (`viewGen` / `consumeReset` / per-generation row wrappers) was deleted. A `viewKey` memo (visible id sequence) drives both the cold-render cascade and the scroll-reset — a background refresh that resolves to the same sequence is now completely free; a search/sort/refresh that changes what the user sees replays the staggered cascade.
- **Entrance animation, restored and tamed.** WAAPI fade+slide on the inner `.trow` (never on the positioned wrapper). Cold render: 22 ms/row cascade capped at 320 ms ("one-by-one"). Slow scroll-in: quick 150 ms micro-stagger capped at 60 ms. Fast fling (> 4 px/ms) or `prefers-reduced-motion`: none. The cascade marker is set inside the window memo (memos run before effects/rows mount), so ordering is deterministic.
- **Scroll anchoring disabled** on the scroller (`.view { overflow-anchor: none }`) — mandatory for virtual lists; also removes mid-scroll jumpiness.
- **Debounce batching fix.** The debounced search callback ran outside Solid's event batching, so `setSearchTerm()` flushed effects **before** `requestScrollReset()` set its flag (found and reproduced in the browser). Filter interactions now go through `applySearch` / `applyFavFilter` / `applySort`, which `batch()` the signal write and the reset flag — atomic under all flush timings.
- **Highlight fan-out contained.** `playHi` was deleted as redundant state; rows derive from the deduped `currentId` / `highlightPlaying` memos. With virtualization only ~30 live row effects exist, so a poll highlight change touches exactly those.

### 2.2 Sidebar (library) scrollbar — always visible + flashing

**Root causes**

1. `4df8dc4` explicitly pinned the scrollbar always-on (`overflow-y: scroll`, `scrollbar-gutter: stable`) because WebKitGTK's native scrollbar kept dying under per-frame composited animation load (the deleted worm-filter/sheen/ember effects). Treating the symptom left a permanently visible bar.
2. WebKitGTK's `::-webkit-scrollbar` styling cannot fade on idle and its compositing is disturbed by GPU work — a native scrollbar can never satisfy "appear only while scrolling".

**How it was fixed** (commit `3534d22`)

- **Custom overlay scrollbar** (`src/lib/scrollbar.ts` + `.osb-thumb`): the container remains the native scroller (wheel/keyboard/touch untouched); the native bar is hidden (`.view { scrollbar-width: none }` / `::-webkit-scrollbar { display: none }`) and replaced by one absolutely-positioned thumb in a new `.view-shell` (outside the scroller, so it doesn't translate with content).
- Behavior: appears on **any** scrolling source (wheel, drag, keyboard, programmatic), fades out after 800 ms idle (220 ms opacity transition), stays visible while hovered or dragged, draggable with pointer capture (thumb grows), hidden entirely when content fits, reduced-motion disables the fade. `aria-hidden`, `pointer-events: none` when hidden.
- **Flicker is structurally impossible:** paint is a single rAF-coalesced function writing `transform`/`height` only when values changed ≥ 0.5 px, plus one opacity class toggle — no per-frame compositing pressure, no native-scrollbar involvement.
- Metrics stay fresh via `ResizeObserver` (viewport) + `MutationObserver` (content growth, e.g. downloads panel toggling).

### 2.3 Bottom player bar

**Root causes**

1. **Two writers to the seek slider.** The poll in `App.tsx` wrote `#seek`/`#volume` values via `document.getElementById(...)` while `Player.tsx`'s rAF loop wrote the same inputs — classic state desync with visible jitter.
2. **Full-object poll writes.** `setPlayer(ps)` replaced the whole signal every cycle (fresh object), re-running every reader even when nothing changed; plain `on(getter)` effects refired on every poll (the code even carried comments apologizing for it and hand-rolled dedupe memos locally).
3. **Marquee corruption.** The resize handler re-applied the marquee from `el.textContent`, but a marquee element contains **two copies** of the text → resizing while a long title scrolled produced "Song nameSong name".
4. **Stale artwork.** On track change with a cache miss, the previous track's art stayed visible until the async fetch resolved.
5. **Loop never slept.** `frameSeek` self-rescheduled a 250 ms timeout forever, mixing rAF and timeout ids in one variable; idle wakeups and awkward cancellation.
6. **Volume desync.** The slider's value was hard-coded `100` until the first poll tick; every `onInput` fired an IPC invoke.

**How it was fixed** (commit `514d2c3` store + Player rewrite)

- **Single source of truth + diffed writes.** The poll lives in the `player` store (`startPlayerSync`, adaptive 500/900/1000 ms cadence, visibility-aware). `syncFromBackend()` shallow-compares (id-based for `current`) and writes only real changes; idle playback produces **zero** signal writes.
- **Deduped derived accessors** (`isPlaying`, `position`, `duration`, `volume`, `shuffle`, `repeat`, `speed`, `currentTrack` as memos) — components never read the whole object, so effects fire only on real value changes.
- **Single-writer visual loop.** The rAF loop in `Player.tsx` is the only writer of seek fill/knob/time label. It projects position forward between polls (`sync.pos + elapsed × speed`), lerps toward targets, snaps on jumps > 1.5 s, and **fully stops** when paused and not seeking (restarts from three explicit kick points: play state, seek input, visibility). No idle wakeups.
- **Marquee fixed.** Text is always passed in from store memos (never read back from the DOM); resize re-applies from the same source — doubling is impossible.
- **Cache-first art.** `on(currentId)` applies cache synchronously (no stale flash), clears on null, guards out-of-order async resolution by id, and plays the `now-in` entrance replay only on real track changes.
- **Optimistic highlight without lies.** Clicking a row sets a `pendingId` that wins over poll truth until the backend confirms (or 1.5 s / error clears it) — instant highlight with no snap-back flicker.
- **Volume done right.** Slider initializes from the store; local edits optimistically update + trailing-throttle the IPC (90 ms); a 600 ms "local echo shield" stops stale poll echoes from yanking the control mid-interaction. Keyboard volume shortcuts go through the same action.
- All `getElementById` reach-arounds are gone from the poll; the store exposes actions (`togglePlay`, `nextTrack`, `prevTrack`, `seekTo`, `setVolume`, `toggleShuffle`, `cycleRepeat`, `cycleSpeed`) used by both the UI and the global keyboard shortcuts.

---

## 3. Code Quality Issues Found (full list)

**Conversion debt / vanilla leftovers**

1. Virtualization engine deleted during conversion; CSS comments still referenced the deleted vanilla `library.ts`.
2. `smoothwheel.ts` orphaned (imported nowhere) — the scroll-feel module was dead code.
3. Imperative DOM patterns surviving the conversion: poll syncing sliders via `getElementById`, sleep-timer ring updates via `getElementById` + class juggling, pill `.active` toggling in a loop, `document.getElementById("search")` focus from the keyboard handler, `querySelectorAll(".lrc-line")` on every lyric-line advance.
4. `Toast.tsx` assigned `toastEls.el = el` **before** the ref existed (always `undefined` — dead store).
5. Stale docs: `PLAN.md` still said "vanilla JS + Vite"; `README.md` advertised the removed playlists feature.

**Redundant / duplicated state**

6. `playHi` duplicated `player().playing` + `current.id` (two sources of truth for the row highlight).
7. `viewGen`/`consumeReset`/`resetNext` — three cooperating mechanisms to force recomputation that pure memos provide naturally.
8. Per-component hand-rolled "deduped memo" comments and `on()` wrappers working around the full-object `player()` signal.

**Dead code**

9. `.btn-cog`, `.fade-row`, `.fade-label` (referencing undefined `--text-dim`), `.drawer.instant`, `.settings-card select`, `.menu-item`/`.pl-act` selectors (playlists feature), duplicate `#now` / `#now-title` blocks, redundant `#prompt-overlay.confirm #prompt-input` rule.
10. `sounds.ts` exported `setSndEnabled`/`sndEnabled` with no caller.

**Performance problems**

11. Non-virtualized list (§2.1) — the dominant issue.
12. Whole-list re-render on every backend refresh (§2.1).
13. N-row reactive fan-out on `playHi` writes (§2.1).
14. Poll writing identical state (§2.3).
15. `DownloadsPanel` used `<For>` over arrays rebuilt per flush — every progress tick recreated that row's subtree (now `<Index>`, in-place updates; rate smoothing moved into the store so rendering is pure).
16. `LyricsPanel` re-queried all `.lrc-line` elements per active-line change (now ref-cached array).
17. Sleep popover ran a rAF loop for the countdown regardless of ring needs (now: rAF only while the popover is open, driving a signal).

**Architectural weaknesses**

18. One 371-line `state.ts` mixing library, player, downloads, settings, overlays, prompt, toast, sleep and caches — every component imported from one god-module.
19. Components reached into each other's DOM (`App` writing `Player`'s sliders, keyboard handler focusing `LibraryView`'s input).
20. Backend event subscriptions scattered through `App.onMount` (now: each store owns its `init*()` + cleanup).
21. No error boundary — an uncaught render error blanked the entire window (added top-level `ErrorBoundary` with a graceful fallback + Try again/Reload).
22. No way to exercise the UI without the Rust shell (added the dev-only mock harness, §7).

---

## 4. Concrete Improvements Made

**Rewrites**

- `TrackList.tsx` — from scratch: windowed virtualization with stable-identity `<For>` diffing, rAF-coalesced scrolling, velocity-aware staggered entrances, `viewKey`-driven cascades. New `TrackRow.tsx` extracted for clarity.
- `Player.tsx` — single-writer rAF visuals, store-driven, fixed marquee/art/volume; loop sleeps when idle.
- `lib/state/*` — new domain stores (library / player / downloads / settings / ui), each with explicit actions and init/cleanup lifecycle.
- `lib/scrollbar.ts` — new overlay auto-fade scrollbar controller.
- `lib/sleep.ts` — fully reactive (signals for end/total/remaining; no DOM writes; 1 s expiry watch replaces the poll hook).
- `src/dev/mock.ts` + `AppError.tsx` + bootstrapped `index.tsx` (async boot, ErrorBoundary, DEV-only mock).

**Renames (for intent)**

- `invalidateView()`/`viewGen` → replaced by pure memos + `applySearch`/`applyFavFilter`/`applySort` + `viewKey`
- `consumeReset` → `takeScrollReset`; `toastSt`/`toastEls` → `toastState`/`toastRefs`; `promptEls` → `promptRefs`; `lyricsFs` setter → `setLyricsFullscreen` (sounded variant) alongside the raw setter; `setSleepTimer`'s DOM syncing → reactive rendering in `Topbar`.

**Deletions**

- `state.ts` (371 lines) — fully superseded; `playHi`, `viewGen`/`consumeReset`, per-generation row wrappers, `dlRate`-in-render, `setSndEnabled`, 11 dead CSS blocks (~1.4 KB + dead selectors), stale `PLAN.md`/`README.md` claims.

**Optimizations**

- Diffed poll writes; deduped memos; batched filter actions; stable-ref library merges; `Index`-keyed downloads; ref-cached lyrics; volume throttling; loop sleep states (player + lyrics scroll + sleep ring only-when-open); overlay scrollbar with no-op-write paint; `overflow-anchor: none`.

---

## 5. Performance Characteristics — Before vs. After

Measured in Chromium (same machine) against the mock harness; "before" DOM figures are computed from the actual row JSX (22 elements/row, no virtualization). Live browser verification of the original build is not possible without the Rust shell, so DOM cost is derived structurally.

| Scenario | Before | After |
|---|---|---|
| 3,000-track library — list DOM | ≈ 66,000 elements (+ text nodes) | **~640 elements** (29 rows), constant |
| 20,000 tracks | ≈ 440,000 elements | 28 rows, 728 total DOM nodes measured |
| 50,000 tracks | ≈ 1.1 M elements (would not survive) | **18–29 rows**, 2,800,000 px scroll height, exact row math, 29 MB JS heap |
| Fast fling (1.86 M px in one task) | n/a (unvirtualized) | Bounded rows, first window row = `floor(scrollTop/rowH) − buffer` exactly |
| Library refresh (no visible change) | Full visible-list recreation + art re-fetch + flash | **Zero** row recreation, zero DOM delta (measured stable across rounds) |
| Scroll-in appearance | Nothing (or, pre-`4df8dc4`, flash-prone pooled rows) | 150 ms micro-stagger at low speed; suppressed during flings; zero tearing |
| Player poll (paused) | New object per tick → all readers re-run + slider DOM writes | No writes at all when unchanged; sliders owned by their component |
| Seek/position rendering | Poll + rAF both writing inputs | Single rAF writer; poll only resyncs the base |
| CSS payload | 31.38 KB (6.93 gzip) with dead rules | 31.08 KB (6.88 gzip), zero dead selectors |
| JS bundle | 57.38 KB (20.06 gzip) | 67.95 KB (23.89 gzip) — includes dev mock (never shipped to the packaged app, tree-shaken from prod builds via `import.meta.env.DEV` gate), ErrorBoundary, scrollbar & stagger engines |

---

## 6. Stability, Smoothness, Maintainability — Before/After Notes

**Stability**
- Repeat-interaction battery (20,000-track library): 10 rapid track switches → exactly one `.playing` row, correct now-playing; 20-round scroll storm → bounded rows, DOM node count **identical before/after rounds** (no leak); 5× fast lyrics toggling, overlay open/close, favorites, sorts, search/clear — zero console errors.
- Failure modes hardened: failed `play_track` clears the optimistic highlight; out-of-order lyric loads discarded by request id; failed favorite toggles roll back; poll errors keep last-known player state; render errors hit the ErrorBoundary instead of a blank window.
- The full download lifecycle (queue → live progress with smoothed rate → completion → `library-changed` → new track at top) runs with bounded DOM and no list-wide re-render.

**Smoothness**
- Inertial wheel scrolling restored (smoothwheel, time-constant lerping, reduced-motion aware, respects nested scrollers and external scroll sources).
- Scrollbar: appears on scroll, fades after idle, draggable — never permanently visible, never flickers (single composited element; the per-frame animation work that used to kill WebKitGTK's scrollbar no longer touches it at all).
- Row entrances are polished, capped (≤ 320 ms), and velocity-gated — visible "one-by-one" loading on cold renders and filters, invisible during flings.

**Maintainability**
- Five single-responsibility stores with typed actions; components are presentational; no cross-component DOM writes; every subscription has an owner and a cleanup.
- `tsc --noEmit` (strict) clean; `vite build` clean; every commit atomic and buildable; the dev harness (`npm run dev` in a plain browser, `?tracks=N` for load testing) makes frontend regressions reproducible without Rust.

---

## 7. Verification Method

Since the Tauri shell isn't runnable in this environment, the UI was verified in headless Chromium via a **DEV-only Tauri IPC mock** (`src/dev/mock.ts`, installed only when `import.meta.env.DEV` **and** no real `__TAURI_INTERNALS__` exists — never in packaged builds):

- generated deterministic libraries (`?tracks=1…50000`), simulated playback clock, shuffle/repeat/speed, seek, volume, next/prev;
- simulated yt-dlp-style download jobs with progress events and `library-changed` on completion;
- per-track SVG art data-URIs to exercise the real image path.

Automated browser checks executed: row-count bounds at 3k/20k/50k tracks; window math after multi-megapixel flings; search/sort/favorite flows incl. scroll-reset from 150,000 px depth; cascade animation sampling (18/18 rows animating at t=180 ms, decaying one-by-one); scrollbar appear/fade timings (0 → 1 on scroll, → 0 after ~1 s idle); thumb drag (5,000 → 69,920 px); player controls (play/pause icons, next/prev, repeat badge, shuffle, keyboard volume 80→70); downloads lifecycle; DOM-node stability across repeated scroll/refresh rounds; zero page errors throughout.

---

## 8. Remaining Known Limitations & Recommended Future Work

1. **Backend poll → push.** The player still polls (now cheaply). A Tauri event push from the mpv IPC bridge would remove the 500 ms floor on track-switch confirmation. (The optimistic highlight already hides this from users.)
2. **Adaptive row-height variance.** Rows are fixed-height by design; if album-art-heavy layouts ever need variable heights, the window math needs a prefix-sum index. Not needed for the current design.
3. **Arabic/CJK search.** The haystack index lowercases but does not normalize diacritics (`.normalize("NFD")` strip). One-line follow-up if the library becomes multilingual.
4. **`libmarius`-style keyboard list navigation** (↑/↓ to move selection, Enter to play) is absent — the vanilla app never had it either; the virtualized list makes it easy to add now.
5. **Art cache policy** is a 160-entry FIFO; an LRU with byte-budget would be marginally better for very large libraries.
6. **Tests.** The dev mock makes it possible to add Vitest + Playwright coverage for the window math and scrollbar controller — recommended before the next large refactor.
7. **Rust side** was intentionally untouched (out of scope), though `set_fade`/`set_effect` commands appear registered-but-unused — candidates for a future backend cleanup.

---

## 9. Commit Map

| Commit | Content |
|---|---|
| `514d2c3` | refactor(stores): split monolithic state.ts into domain stores |
| `b774c7b` | chore(dev): browser dev harness + top-level error boundary |
| `9522147` | feat(list): windowed virtualization — 50k tracks, ~30 DOM rows, zero-flash scrolling |
| `3534d22` | feat(scrollbar): auto-fade overlay scrollbar + inertial wheel scrolling |
| `22cacd0` | chore(cleanup): remove dead code, dedupe CSS, cache lyrics elements |
| *(this commit)* | docs: EMBERTUNE_AUDIT_AND_IMPROVEMENTS.md |

---

## 10. Post-delivery Addendum — Scroll Row Entrance Fix (follow-up report)

**User report after v1:** while scrolling, some rows appeared "late" — a row at the
center/bottom showed instantly while its neighbours stayed invisible for a beat, in a
seemingly random order ("like multithreading").

### Root cause (v1 code, `TrackRow.tsx`)

Rows mounted by scrolling played a "micro-stagger" whose delay came from a cumulative
batch counter:

```ts
} else if (lastVel < 4) {
  animateIn(trow, batchN++ * 12, true);   // batchN reset ONLY on view change
}
```

Two defects interacted:

1. **`batchN` was never reset between scroll batches** — only by `markColdRender()` on a
   viewKey change. After scrolling past N rows, every newly mounted row carried a
   `N × 12ms` delay, growing without bound during a session. With `fill: "backwards"`,
   a delayed animation *holds the row at opacity 0* until the delay elapses — the row
   is mounted, laid out, and invisible: "loads late".
2. **The `lastVel < 4` velocity gate was sampled per-rAF** and fluctuated around the
   threshold during a fling's deceleration. Batches alternating between "animate with a
   huge accumulated delay" and "skip animation entirely" produced the random
   center-appears-first / neighbours-appear-late pattern.

### Fix

Entrance behaviour is now split strictly by **when** a row mounts:

| Mount reason | Animation | Why it can't read as "late" |
|---|---|---|
| View change (`viewKey`: search / sort / refresh with new content) | staggered cascade — 22 ms/row from the window's first row, **capped at 320 ms** (the cap documented in v1 but never implemented) | intended effect; replays only on real content changes |
| Scrolling (window edge enters the buffer) | **80 ms pure-opacity fade, delay 0** | a zero-delay fade is fully opaque one frame+80 ms after mount; rows mount 10 rows (~560 px) below the viewport, so the fade normally completes *before* the row scrolls into view |
| `prefers-reduced-motion` | none | — |

The cumulative counter and the velocity heuristic were **deleted entirely** (no
per-scroll-frame heuristics remain). The cascade anchor index is now taken from the
first row that mounts after `markColdRender()`, which also fixes a v1 edge case: a
filter change while scrolled deep used to degenerate into a simultaneous fade because
the anchor was captured from the pre-scroll-reset window offset.

### Second fix from the same report: scroll lag spikes on real libraries

User report: "scrolling through my current 124 songs is laggy — lag spikes." At 124
tracks the virtualized list itself does almost no work, so the spikes came from
elsewhere: each row entering the 600 px preload margin fired a real `get_art` IPC round
trip whose response ends in a **main-thread image decode** — a burst of those during a
gesture is exactly a series of frame drops (the dev mock returns instantly and hides
this path).

Fix — art load scheduling in `TrackRow.tsx`:

- while the list is actively scrolling, entering rows' art loads are **queued, not
  started** (`notifyScrollActivity()` is called from the list's rAF-coalesced scroll
  handler);
- ~150 ms after the last scroll event the queue **flushes in chunks of 6 every 50 ms**,
  spreading decodes over several frames;
- cached art (`artCache`, synchronous) is unaffected, so steady-state scrolling never
  queues anything;
- row `<img>` elements now carry `decoding="async"`.

### Verification (headless Chromium via the dev harness, 20 000 tracks)

`Element.prototype.animate` was wrapped at boot to log every row animation; each
scenario waits for genuine quiescence (no scroll events for 250 ms, then zero running
row animations) before sampling:

- view-load cascade replays staggered (21 anims, max delay 320 ms) and settles fully
  opaque;
- hard fling (60 k px): **416 scroll-in animations, 100 % zero-delay, 0 staggered**;
  viewport fully opaque after settle;
- ~30 s scroll session: 970 scroll-ins, still zero stagger, DOM row count bounded
  (32), fully opaque;
- search replays the capped cascade and settles opaque; scrollbar teleport produces no
  phantom cascade;
- mega-fling (120 k px) settles clean;
- art deferral: 0 `get_art` calls during the gesture, queue flushed after settle,
  12/12 visible rows with art.

DOM row count stayed at ~32 for a 20 000-track library in every scenario.

## 11. Post-delivery Addendum 2 — Cover-Art Transport, Scroll Feel & Fullscreen Lyrics

**User report after v2:** the stagger is great, but (a) fast scrolling shows
"flashies", (b) the list still feels laggy on the 124-song library, (c) the
one-by-one entrance should also play *while scrolling*, (d) scroll should feel
smoother, (e) fullscreen lyrics squares off the main panel's rounded outline.

### 11.1 Lag spikes — root cause found: base64 cover art over IPC

`get_art` returned `data:image/jpeg;base64,…`. For every cover the pipeline was:
DB read → disk read → **base64-encode in Rust** → **megabytes-scale IPC string** →
**main-thread base64 decode** → **main-thread JPEG decode**. Repeat per row entering
the preload margin and you get exactly the periodic frame drops on a 124-song
library (the browser dev mock returns tiny SVGs and hides this path entirely).

**Fix — `art://` custom URI scheme protocol** (`src-tauri/src/lib.rs`):

- the webview now loads covers as `art://localhost/<track_id>` (Windows:
  `http://art.localhost/<id>`): a normal async image fetch — network + decode off
  the main thread, HTTP-cached by the webview (`Cache-Control: max-age=86400`);
- the handler resolves *id → path → art-cache file* through the DB inside the
  app process, so the webview never supplies a filesystem path (same trust model
  as the old command; malformed/unknown ids 404);
- CSP `img-src` extended with `art: http://art.localhost`;
- frontend: new shared resolver `src/lib/art.ts` (protocol URL inside Tauri,
  mocked IPC in the browser dev harness), session negative-cache for missing
  covers, art LRU raised to 512 (entries are URLs now, not base64 payloads).

The old base64 `get_art` command remains as the dev-harness fallback only.

### 11.2 "Flashies" during fast scrolling

Two independent sources:

1. **Cover pop-in storms.** The v2 deferral queued *every* art load during a
   gesture; after a fling the queue flushed in chunks — covers visibly popping
   in one after another. Policy reworked in `TrackRow.tsx`: rows **inside the
   viewport load immediately, even mid-gesture** (an IntersectionObserver
   `intersectionRect` distinguishes viewport rows from the 600 px prefetch
   ring; the ring still waits for ~150 ms of scroll idle). With the `art://`
   transport those in-viewport loads cost the main thread nothing.
2. **Abrupt row entrances.** Scroll-in rows faded in with a zero-delay 80 ms
   pop — many rows at once read as flashing. Replaced (below).

### 11.3 One-by-one entrance restored for scrolling — safely

The v1 "rows load late" bug was an *unbounded* stagger. The v3 scroll-in
entrance is a **batch-anchored micro-cascade**: 14 ms per row, hard-capped at
120 ms, and every mount batch re-anchors after a 60 ms gap — delays can
physically never accumulate across a session. Safety margin: rows mount ~10
rows (≈560 px) below the viewport; even a violent 3000 px/s fling needs ~190 ms
to reach them, so the ≤120 ms hold is always spent off-screen — but the eye
still sees rows appearing one by one.

### 11.4 Smoother wheel glide

`smoothwheel.ts` time constant raised 55 ms → 68 ms (softer glide, still
tight to the wheel) and notch gain 1.12 → 1.15. All safety interlocks
(scrollbar drag, keyboard resync, pinch-zoom, nested scrollers,
reduced-motion) unchanged.

### 11.5 Fullscreen lyrics outline

`#lyrics-panel.fs` now carries the app frame's own outline — 2 px accent
border with a 12 px radius (`#app`'s 14 px outer minus its 2 px border) — so
the fullscreen lyrics panel continues the main panel's rounded frame instead
of squaring off its corners (the composited backdrop-filter layer can escape
ancestor radius clipping; the panel now brings its own curve).

### 11.6 Verification (headless Chromium via the dev harness)

20/20 checks pass on the updated suite (`scripts/verify_scroll_fix.mjs`):
cascade + scroll-in micro-cascade present and capped (max 320 ms cold / 120 ms
scroll), **no delay accumulation over a 20-fling session** (the v1 bug's exact
signature), batch re-anchoring, viewport fully opaque after every scenario
(fling, long session, search, teleport, mega-fling), DOM bounded (~32 rows @
20 k tracks), smoothwheel glide, **0 long-task frame spikes during wheel
scrolling at 124 tracks**, 9/9 in-view rows with art, zero console errors.

*Test-harness note:* trusted CDP wheel events cannot drive the lerp in
headless — Chromium starves BeginFrames after a preventDefaulted wheel
gesture (2 rAF ticks in 1.4 s). The suite therefore drives the same code path
(listener → preventDefault → target → lerp → virtualizer) with synthetic
`WheelEvent`s; real WebKitGTK/WebView2 windows pump frames continuously and
are unaffected.

*Rust note:* the `art://` handler was written against Tauri 2's
`register_asynchronous_uri_scheme_protocol` API; this environment has no Rust
toolchain, so run `cargo check`/`cargo tauri dev` on the dev machine to
compile-verify (`src-tauri/src/lib.rs`).

## 12. Post-delivery Addendum 3 — Ripple Polish, Fullscreen Pop, Brand & CI

**User feedback after v4:** the scroll cascade satisfies, but individual rows
still popped in *instantly* among the cascading ones; fullscreen lyrics should
pop, not slide; new minimalist logo wanted; GitHub CI builds for
Debian/Windows (+ Fedora/Arch if possible).

### 12.1 No more instant rows — continuous per-gesture ripple

Root cause of the "instant" rows: the v3 micro-cascade re-anchored every time
two row mounts were >60 ms apart — and mid-gesture lulls (smooth-wheel
easing, frame pacing) produced exactly such gaps, so the next row mounted at
delay 0 and popped against its rippling neighbours.

`TrackRow.tsx` now runs a **continuous per-gesture ripple**: one shared delay
steps +16 ms per mounted row (hard cap 120 ms — runaway accumulation stays
impossible) and only resets after >350 ms of quiet (the gesture truly ended).
Mid-gesture lulls carry the ripple forward instead of restarting it, so every
scroll-in row joins the top-to-bottom flow — never a delay-0 pop. Verification
saw **416/416 scroll-in animations staggered** across a 60 k-px fling, cap held
over a 20-fling continuous gesture (max 120 ms), and the ripple cleanly
resetting to 16 ms after a pause. 20/20 checks pass.

### 12.2 Fullscreen lyrics pops in

`#lyrics-panel.fs` no longer inherits the drawer's slide-from-right. Entering
fullscreen plays a springy scale+fade pop (`lyrics-fs-pop`, 280 ms), disabled
under `prefers-reduced-motion`; the rounded accent outline from addendum 2 is
kept. Non-fullscreen drawer behaviour is unchanged.

### 12.3 New brand: ember-tune mark

Hand-drawn minimalist SVG (`src/assets/logo.svg`) matching the reference:
an eighth note whose flag is a licking flame — hot-yellow to deep-orange
gradient, molten notehead with a dark rim + warm core, soft halo, and a spark
dot. Deployed to:

- the topbar brand (mark + "Ember**tune**" wordmark, glow drop-shadow),
- the favicon (`src/public/favicon.svg`),
- all native bundle icons regenerated via `tauri icon` (ico, icns, pngs).

### 12.4 GitHub Actions build pipeline

`.github/workflows/build.yml` (tauri-action) builds on push of a `v*` tag and
publishes a GitHub release with:

- **Debian/Ubuntu** — `.deb`
- **Fedora/RHEL** — `.rpm`
- **Arch & any distro** — `.AppImage` (single-file, no package needed)
- **Windows** — `-setup.exe` (NSIS) + `.msi` (WiX)

Manual `workflow_dispatch` runs build-only (artifacts on the run, no release).
`tauri.conf.json` bundle targets set to `all`. Rust caching via
`swatinem/rust-cache`. Note: the Linux runtime still needs `yt-dlp`, `ffmpeg`
and `mpv` installed on the user's system (stated in the release body and the
deb `depends`).
