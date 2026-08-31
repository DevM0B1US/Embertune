// ═══════════════════════════════════════════════════════════════════
//  Overlay scrollbar — an auto-fading custom scrollbar for the
//  library view.
//
//  Why custom: WebKitGTK's native scrollbar is always visible when
//  styled via ::-webkit-scrollbar, cannot fade on idle, and its
//  compositing is disturbed by per-frame animation work. This overlay
//  thumb is a plain composited div:
//    · appears while scrolling (any source — wheel, drag, keyboard,
//      programmatic) and fades out after ~800ms idle
//    · draggable, with a larger visual while dragging
//    · paint is rAF-coalesced and skipped while values are unchanged
//    · respects prefers-reduced-motion (no fade transition)
//  The container stays the native scroller — wheel/keyboard/touch
//  behavior is untouched.
// ═══════════════════════════════════════════════════════════════════

const THUMB_MIN = 32; // px — smallest useful thumb
const EDGE_PAD = 3; // px — top/bottom inset inside the shell
const HIDE_AFTER_MS = 800;

export function attachOverlayScrollbar(view: HTMLElement, thumb: HTMLElement): () => void {
  thumb.setAttribute("aria-hidden", "true");

  let hideTimer: number | undefined;
  let paintRaf = 0;
  let dragging = false;
  let dragStartY = 0;
  let dragStartScroll = 0;
  let lastTop = -1;
  let lastH = -1;
  let lastOverflow = -1;

  const hasOverflow = (): number => view.scrollHeight - view.clientHeight;

  function paint(): void {
    paintRaf = 0;
    const overflow = hasOverflow();
    if (overflow <= 1) {
      if (lastOverflow !== overflow) {
        lastOverflow = overflow;
        thumb.classList.remove("osb-on");
        thumb.style.pointerEvents = "none";
      }
      return;
    }
    const vh = view.clientHeight;
    const h = Math.max(THUMB_MIN, Math.round(vh * (vh / view.scrollHeight)));
    const maxTop = vh - h - EDGE_PAD * 2;
    const y = EDGE_PAD + (view.scrollTop / overflow) * maxTop;
    if (Math.abs(h - lastH) > 0.5) {
      thumb.style.height = `${h}px`;
      lastH = h;
    }
    if (Math.abs(y - lastTop) > 0.5) {
      thumb.style.transform = `translateY(${y}px)`;
      lastTop = y;
    }
    lastOverflow = overflow;
  }

  const requestPaint = (): void => {
    if (!paintRaf) paintRaf = requestAnimationFrame(paint);
  };

  function armHide(): void {
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      if (!dragging && !thumb.matches(":hover")) thumb.classList.remove("osb-on");
    }, HIDE_AFTER_MS);
  }

  function onScroll(): void {
    requestPaint();
    thumb.style.pointerEvents = "";
    thumb.classList.add("osb-on");
    armHide();
  }

  // ── drag to scroll ─────────────────────────────────────────────────
  const onThumbDown = (e: PointerEvent): void => {
    dragging = true;
    thumb.setPointerCapture(e.pointerId);
    dragStartY = e.clientY;
    dragStartScroll = view.scrollTop;
    thumb.classList.add("osb-drag");
    window.clearTimeout(hideTimer);
    e.preventDefault();
  };

  const onThumbMove = (e: PointerEvent): void => {
    if (!dragging) return;
    const overflow = hasOverflow();
    if (overflow <= 0) return;
    const maxTop = view.clientHeight - thumb.getBoundingClientRect().height - EDGE_PAD * 2;
    view.scrollTop = dragStartScroll + ((e.clientY - dragStartY) / maxTop) * overflow;
  };

  const onThumbUp = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    if (thumb.hasPointerCapture?.(e.pointerId)) thumb.releasePointerCapture(e.pointerId);
    thumb.classList.remove("osb-drag");
    armHide();
  };

  thumb.addEventListener("pointerdown", onThumbDown);
  thumb.addEventListener("pointermove", onThumbMove);
  thumb.addEventListener("pointerup", onThumbUp);
  thumb.addEventListener("pointercancel", onThumbUp);
  thumb.addEventListener("pointerenter", () => window.clearTimeout(hideTimer));
  thumb.addEventListener("pointerleave", () => armHide());

  view.addEventListener("scroll", onScroll, { passive: true });

  // keep metrics fresh when the viewport or content size changes
  const ro = new ResizeObserver(requestPaint);
  ro.observe(view);
  const mo = new MutationObserver(requestPaint);
  mo.observe(view, { childList: true, attributes: true, subtree: false });

  return () => {
    window.clearTimeout(hideTimer);
    if (paintRaf) cancelAnimationFrame(paintRaf);
    view.removeEventListener("scroll", onScroll);
    thumb.removeEventListener("pointerdown", onThumbDown);
    thumb.removeEventListener("pointermove", onThumbMove);
    thumb.removeEventListener("pointerup", onThumbUp);
    thumb.removeEventListener("pointercancel", onThumbUp);
    ro.disconnect();
    mo.disconnect();
  };
}
