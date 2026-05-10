import { defineConfig } from "vitest/config";

// Minimal vitest config — does NOT inherit vite.config.ts because that file
// sets `root: 'src'` and adds dev/build plugins (tailwind, SPA rewrites,
// sample-comp middleware) that aren't needed for tests and slow startup.
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    globals: false,
    setupFiles: ["./test-setup.ts"],
  },
});
