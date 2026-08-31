// ═══════════════════════════════════════════════════════════════════
//  Modal focus management (audit U3).
//
//  When a modal opens, focus moves to its first interactive element and
//  Tab cycles within the dialog instead of reaching the background UI.
//  Escape handling stays where it was (App-level for settings/meta,
//  input-level for the prompt) so behavior is unchanged.
// ═══════════════════════════════════════════════════════════════════

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Move focus into the dialog once it opens. Call inside a createEffect
 *  that tracks the open signal. The overlay fades in with a `visibility`
 *  transition (0.22s) — while it computes as hidden, focus() is a silent
 *  no-op, so the attempt is retried per frame until it sticks (bounded). */
export function focusModal(open: boolean, overlay: HTMLElement): void {
  if (!open) return;
  queueMicrotask(() => {
    const deadline = performance.now() + 350;
    const attempt = (): void => {
      const first = overlay.querySelector<HTMLElement>(FOCUSABLE);
      if (!first) return;
      first.focus();
      if (document.activeElement === first) return;
      if (performance.now() >= deadline) return; // give up quietly
      requestAnimationFrame(attempt);
    };
    attempt();
  });
}

/** Keep Tab (and Shift+Tab) cycling inside the dialog while it is open.
 *  Returns a cleanup that removes the listener. */
export function trapModalFocus(overlay: HTMLElement): () => void {
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Tab") return;
    const focusables = Array.from(overlay.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null || el === document.activeElement
    );
    if (focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey) {
      if (active === first || !overlay.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || !overlay.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  };
  overlay.addEventListener("keydown", onKey);
  return () => overlay.removeEventListener("keydown", onKey);
}
