# Embertune — Audit Remediation Map

Companion to `EMBERTUNE_FULL_CODEBASE_AUDIT.md` (the user-supplied full
codebase audit, verdict 6.5/10). This file maps every finding to its fix.
Full narrative + verification details: §13 of `EMBERTUNE_AUDIT_AND_IMPROVEMENTS.md`.

| Audit ID | Severity | Status | Fix summary |
|----------|----------|--------|-------------|
| B1 | ⛔ CRITICAL | ✅ FIXED | `load_track` writes one `.m3u` and calls `loadlist replace` — O(1) IPC instead of N appends |
| B2 | ⛔ CRITICAL | ✅ FIXED | `state()` fetches only the current track (`get_track(id)`); no queue clone, no `IN (…N…)` per poll |
| B3 | 🔴 HIGH | ✅ FIXED | art effect `defer: true` removed — art loads on reload-while-playing |
| B4 | 🔴 HIGH | ✅ FIXED | observer lives in a per-`LibraryView` `RowFx` instance; `dispose()` on unmount, rebuilt when the root element changes |
| SE1 | 🔴 HIGH | ✅ FIXED | `settings.json` + temp file chmod `0o600` on every persist; existing files tightened on load |
| TE1 | 🔴 HIGH | ✅ FIXED | Vitest (27 tests) + two Playwright suites (20-check scroll, 16-check smoke); DEV-only dialog test hook |
| B5 | 🟠 MEDIUM | ✅ FIXED | LRC parser extracted to `lib/lrc.ts` — multi-timestamp lines, metadata, `[offset:]`, sorted |
| B6 | 🟠 MEDIUM | ✅ FIXED | `setPointerCapture` on the volume slider (+ `onLostPointerCapture`) |
| B7 | 🟠 MEDIUM | ✅ FIXED | smoothwheel removes wheel/scroll listeners in cleanup |
| B13 | 🟠 MEDIUM | ✅ FIXED | shuffle ON → mpv `playlist-shuffle` + queue re-sync; OFF → base order rebuilt, current track + playhead kept |
| Q1 | 🟠 MEDIUM | ✅ FIXED | Client ID read via ref, not `document.getElementById` |
| Q2 | 🟠 MEDIUM | ✅ FIXED | TrackRow module state → `RowFx` context owned by `LibraryView` (tunings unchanged) |
| Q12 / D1 | 🟠 MEDIUM | ✅ FIXED (adapted) | Prettier + oxlint + Vitest wired into scripts and CI. ESLint/typescript-eslint is technically impossible on TypeScript 7 (no classic compiler API; peer range <6.1) |
| SE2 | 🟠 MEDIUM | ⏸ DEFERRED | `unsafe-hashes` labor-intensive, bounded risk (Solid needs inline style attrs) |
| U1 | 🟠 MEDIUM | ✅ FIXED | focusable listbox, ↑/↓/PgUp/PgDn/Home/End selection, Enter/Space play; global shortcuts excluded while list focused |
| U3 | 🟠 MEDIUM | ✅ FIXED | focus-in + Tab trap for Settings/Meta/Prompt + `role="dialog"` `aria-modal` |
| B8 | 🟡 LOW | ✅ FIXED | double-open prompt resolves pending promise with `null` |
| B9 | 🟡 LOW | ✅ FIXED | `kindOfUrl` mirrors backend (`open.spotify.com` / `spotify:`) |
| B10 | 🟡 LOW | ✅ FIXED | poll failures: warn @3, toast @8, reset on recovery |
| B11 | 🟢 TRIVIAL | ✅ FIXED | mock `btoa` Unicode-safe via `TextEncoder` |
| B12 | 🟡 LOW | ✅ FIXED | 5s overall mpv request deadline |
| B14 | 🟡 LOW | ✅ FIXED | `lineEls.length = 0` on every lyrics load |
| B15 | 🟡 LOW | ✅ FIXED (documented) | memo side-effect kept deliberately + loud comment (effect would anchor a row late) |
| P5 | 🟡 LOW | ✅ FIXED | lyrics auto-scroll rAF cancelled on panel close |
| P6 | 🟡 LOW | ✅ FIXED | sleep countdown 1s interval (was 60fps rAF) |
| Q3 | 🟡 LOW | ✅ FIXED | `applyTheme` single-writer (effect) |
| Q5 | 🟡 LOW | ⏸ DEFERRED | `lib.rs` module split skipped — no compiler in authoring sandbox; CI now compiles, split can follow |
| Q6 | 🟡 LOW | ✅ FIXED | 7 dead commands removed from the IPC surface; dormant engines kept with rationale; `base64` dep dropped |
| Q7–Q9 | 🟡 LOW | ✅ FIXED | `util.rs` single definitions (`is_audio_file`, `split_title`, `unix_now`) |
| Q10 | 🟡 LOW | ✅ FIXED | `iconBody` escapes attributes; `IconNode` prop type |
| Q11 | 🟡 LOW | ✅ FIXED | `noUnusedLocals` / `noUnusedParameters` / `noImplicitReturns` / `noFallthroughCasesInSwitch` on, clean |
| Q13 | 🟢 TRIVIAL | ✅ VERIFIED | `typescript@7.0.2` is the real tsgo toolchain (lockfile + `npm ls`) — drives the ESLint decision above |
| T2–T4 | 🟡 LOW | ✅ FIXED | `RepeatMode` / `JobKind` / `JobStatus` unions |
| T6/T7 | 🟡 LOW | ⏸ DEFERRED | audit: "no bug" — f64 duration churn not worth it |
| U2 | 🟡 LOW | ✅ FIXED | `role="listbox"`/`option`, `aria-selected`, `aria-activedescendant` |
| U5 | 🟡 LOW | ✅ FIXED | reduced-motion respected in marquee + lyrics auto-scroll |
| U10 | 🟡 LOW | ✅ FIXED | drag-and-drop audio files (Tauri `onDragDropEvent`) |
| A2 | 🟡 LOW | ✅ FIXED | `sleep.ts` → `lib/state/sleep.ts` |
| A6 | 🟡 LOW | ✅ FIXED | `AtomicBool` shutdown flag for connect/fade threads |
| A8 | 🟡 LOW | ⏸ DEFERRED | audit: "acceptable for an MVP" |
| A9 | 🟡 LOW | ⏸ DEFERRED | startup ffprobe batching needs a probe lib; flagged as future work |
| A10 | 🟢 TRIVIAL | ✅ FIXED | `lrclib.net` removed from download allowlist |
| D4 | 🟡 LOW | ✅ FIXED | `PLAN.md` marked historical, modules refreshed |
| D2 | 🟡 LOW | ✅ FIXED | `.github/workflows/ci.yml` — frontend gates + `cargo check`/`cargo test` |

**Totals:** 39 fixed · 6 deferred with reasons (SE2, Q5, T6/T7, A8, A9,
Sprint-6 push-over-poll) · 1 verified-only (Q13).

⚠️ **Rust compile status:** this round's Rust changes were authored in a
sandbox without cargo. They are reviewed but NOT compiled. CI runs
`cargo check --all-targets` + `cargo test` on every push; run
`npm run tauri dev` (or `cargo check`) locally before packaging.
