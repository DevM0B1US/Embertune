import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  root: "src",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2021",
  },
  // vitest (audit TE1) — pure-logic unit tests; component behavior is
  // covered by the Playwright verification scripts in the repo tooling
  test: {
    environment: "node",
    // root is "src" (vite root) — patterns are root-relative
    include: ["**/*.test.ts"],
  },
});
