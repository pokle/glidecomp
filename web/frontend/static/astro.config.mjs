// @ts-check
import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import tailwindcss from "@tailwindcss/vite";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

// The static content pages (home, about, legal, scoring/*) are prerendered to
// plain HTML and merged into the frontend's dist/ alongside the Vite SPA. See
// the sibling vite.config.ts for the build merge + dev proxy that stitch the
// two together.
//
// In dev the whole Astro site is served under a `/_static` base so its Vite
// asset/HMR namespace can't collide with the SPA's Vite dev server; the SPA's
// dev middleware proxies `/_static/*` (and the clean page routes) here. In the
// production build the base is `/` so pages sit at their real URLs.
const devBase = process.env.ASTRO_BASE || undefined;

export default defineConfig({
  output: "static",
  base: devBase,
  trailingSlash: "ignore",
  // The dev toolbar's entrypoint loads from a root-level Vite URL that would
  // collide with the SPA's dev server when proxied; we don't need it here.
  devToolbar: { enabled: false },
  // KaTeX is prerendered at build so the scoring pages ship zero client JS.
  markdown: {
    remarkPlugins: [remarkMath],
    rehypePlugins: [rehypeKatex],
  },
  integrations: [mdx()],
  vite: {
    // Don't inherit the sibling SPA's vite.config.ts (its html rollup input
    // breaks Astro's SSR build); Astro provides its own Vite config.
    configFile: false,
    plugins: [tailwindcss()],
    // Browser connects the HMR socket directly to the Astro dev server so we
    // don't have to proxy websockets through the SPA's Vite server.
    server: { hmr: { clientPort: 4321 } },
  },
  server: { port: 4321 },
});
