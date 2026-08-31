import { toastRefs, toastState } from "../lib/state/ui";

export default function Toast() {
  return (
    <div
      ref={(el) => (toastRefs.el = el)}
      id="toast"
      class="toast"
      classList={{ hidden: toastState().hidden, leaving: toastState().leaving }}
      aria-live="polite"
    >
      {toastState().text}
    </div>
  );
}
