import { defineConfig } from "vitest/config";

export default defineConfig({
  // The UI tests render Preact components (menu.test.ts).
  oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
  test: { include: ["src/**/*.test.ts"] },
});
