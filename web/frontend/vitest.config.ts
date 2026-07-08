import { defineConfig } from "vitest/config";
import { resolve } from "path";

// Minimal vitest config — does NOT inherit vite.config.ts because that file
// sets `root: 'src'` and adds dev/build plugins (tailwind, SPA rewrites,
// sample-comp middleware) that aren't needed for tests and slow startup.
export default defineConfig({
  // Mirror the app's "@/…" → src alias so tests can import components that use it.
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
  },
  // The app build defines this git-sha global (see vite.config.ts); stub it so
  // components that reference it (Shell's footer) render under test.
  define: {
    __GIT_SHA__: JSON.stringify("test"),
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    globals: false,
    setupFiles: ["./test-setup.ts"],
  },
});
