import { defineConfig } from "vitest/config";

// Tests kører uden app-pluginnerne fra vite.config.ts. Filer, der skal bruge
// DOM'en (fx TipTap), sætter `// @vitest-environment jsdom` øverst.
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify("test"),
    __BUILD_TIME__: JSON.stringify("1970-01-01T00:00:00.000Z"),
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
