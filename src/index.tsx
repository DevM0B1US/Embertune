/* @refresh reload */
import { ErrorBoundary } from "solid-js";
import { render } from "solid-js/web";
import App from "./App";
import AppErrorInfo from "./dev/AppError";

async function bootstrap(): Promise<void> {
  // DEV-only: run the UI in a plain browser against the IPC mock
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    const { installTauriMock } = await import("./dev/mock");
    installTauriMock();
  }

  render(
    () => (
      <ErrorBoundary fallback={(err, reset) => <AppErrorInfo err={err} reset={reset} />}>
        <App />
      </ErrorBoundary>
    ),
    document.getElementById("app")!
  );
}

void bootstrap();
