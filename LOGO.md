# Embertune — Logo Design Spec

**App:** Embertune — a lightweight Tauri 2 music player for Linux.
**Personality:** ember, fire, dusk. "Ember" (a glowing coal that never quite dies) + "tune" (music).

The logo must read as a **single glowing ember shaped like a music note** — fire that hums.

---

## Concept

One glyph, one idea: **an eighth note (♪) whose head is a hot ember.**

- The **note head** is a slightly imperfect circle — a coal, not a ball bearing. It glows from within.
- The **stem** rises as a clean, tapered line — drawn like a wisp of smoke that has gone straight.
- A single **flag / hook** curls off the top like the last tongue of a flame.
- The overall silhouette stays simple enough to survive at 32 px and in a launcher dock.

It must be recognisable as *music*, then *fire*, in that order.

---

## Color

Primary palette (already used throughout the UI):

| Role              | Hex       | Use                                       |
| ----------------- | --------- | ----------------------------------------- |
| Ember core        | `#FF6B35` | main body of the note                     |
| Ember hot core    | `#FF9A5C` | highlight — where the heat is              |
| Gold tip / spark  | `#FFD166` | the flame hook + one spark dot             |
| Deep coal         | `#8A2D0C` | shadow / underside of the head             |
| Asphalt base      | `#121316` | app background (dark)                      |
| Cinder white      | `#E8E6E3` | monochrome / light-theme variant line work |

Gradients must run **bottom-left to top-right** (`#8A2D0C → #FF6B35 → #FF9A5C`), so the heat rises like a real ember.

---

## Shape rules

- **Note head:** circle with a flat, quiet top — the "cut" where a coal sits in a grate. Radius should be warm, never a perfect circle.
- **Stem:** starts inside the head's right side, rises ~1.6× the head diameter. Taper slightly (wider at base).
- **Flag:** one smooth flame-like curl off the stem top-right, ending in a rounded point. Two flags max at large sizes; one at small sizes.
- **Spark:** one tiny `#FFD166` dot, floating just off the flag tip — the "pop" that makes it feel alive. Only appears at ≥48 px; drop it smaller.
- **Glow:** a soft radial halo behind the head (dark themes only). Never a hard outline.

---

## Variants

| Variant          | Where                          | Notes                                          |
| ---------------- | ------------------------------ | ---------------------------------------------- |
| **Ember (default)** | Launcher, window header, README | Orange gradient + subtle halo, dark or light bg |
| **Cinder (mono)**   | Light theme tray, monochrome UI | `#121316` solid on light, `#E8E6E3` on dark     |
| **Ash (outline)**   | Tiny sizes, print, watermark   | 1.5–2 px stroke, no gradient, no glow           |

The Linux desktop ships the **Ember** variant for the hicolor icon set (see below).

---

## Composition

- Master canvas **1024 × 1024 px**, glyph centered at ~64 % of the canvas, safety padding around.
- The note leans **+3°** (clockwise) — subtle life, not a random tilt.
- No text in the icon. The wordmark is separate (see below).

## Wordmark

Used only for the README / branding banner — never in the icon:

- **"Embertune"** in a light/medium geometric sans (e.g. Inter), lowercase.
- "Ember" in `#FF6B35`, "tune" in the foreground text color.
- A short horizontal flame-tick replaces the dot over a hypothetical "i" — or sits after the word like a punctuation ember.

---

## Technical specs

- **Source format:** one master `SVG` (gradients + glow as filters or layers).
- **Raster exports:** `icon.png` 512×512, `128x128.png`, `64x64.png`, `32x32.png`, `16x16.png`, plus the standard Tauri/Windows set (`icon.ico`, `icon.icns`).
- **freedesktop (Linux):** drop a **hicolor** theme tree with `apps/embertune.svg` + per-size PNGs (16, 22, 24, 32, 48, 64, 128, 256, 512). Include a dark-theme-aware `apps-64`/`apps-128` spot for the halo on light desktops.
- **Scalability test:** at 16 px the glyph must remain a legible note; if not, drop the flag and keep head + stem + spark-line.
- **Aspect ratio:** always square.

---

## Do / Don't

**Do:**
- Keep one glyph. One note, one ember.
- Let the glow live only on dark backgrounds.
- Make the spark optional — the logo must work without it.
- Test on GNOME (light/dark), KDE, and a bare X11 tray.

**Don't:**
- Don't add a literal flame above the note — the flag *is* the flame.
- Don't use drop shadows or bevels; use glow, not pseudo-3D.
- Don't write "Embertune" inside the square icon.
- Don't animate the icon (the app itself handles liveliness).
- Don't make it look like a match or a lighter — it's a coal, not a flame thrower.

---

## Alternate direction (if the note-ember doesn't land)

A **vinyl record with a glowing core**: dark disc, one ember-orange groove spiraling in, center label replaced by a tiny smolder. Stronger "music" signal, weaker "ember" signal. Keep this as the fallback only.

---

*Glow warm, glow steady. A spark neglected burns the house.*