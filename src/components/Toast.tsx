import { toastEls, toastSt } from "../lib/state";

export default function Toast() {
  let el!: HTMLDivElement;
  toastEls.el = el; // set on mount below
  return (
    <div
      ref={(e) => {
        el = e;
        toastEls.el = e;
      }}
      id="toast"
      class="toast"
      classList={{ hidden: toastSt().hidden, leaving: toastSt().leaving }}
      aria-live="polite"
    >
      {toastSt().text}
    </div>
  );
}
