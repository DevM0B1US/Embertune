import type { JSX } from "solid-js";

// ═══════════════════════════════════════════════════════════════════
//  Top-level error boundary fallback — graceful degradation instead
//  of a blank window when a rendering error escapes a component.
// ═══════════════════════════════════════════════════════════════════

export default function AppErrorInfo(props: {
  err: unknown;
  reset: () => void;
}): JSX.Element {
  const message = () =>
    props.err instanceof Error ? props.err.message : String(props.err ?? "Unknown error");
  return (
    <div class="app-error" role="alert">
      <div class="app-error-title">Something went wrong</div>
      <pre class="app-error-msg">{message()}</pre>
      <button class="btn primary" onClick={() => props.reset()}>
        Try again
      </button>
      <button class="btn" onClick={() => location.reload()}>
        Reload
      </button>
    </div>
  );
}
