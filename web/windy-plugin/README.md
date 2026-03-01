# @taskscore/windy-plugin

Windy.com plugin for TaskScore flight analysis. Loads IGC files and renders flight tracks, events, and task turnpoints on Windy's Leaflet map.

## Setup

```bash
bun install   # from repo root — installs all workspace deps
```

## Development

1. Enable developer mode at https://www.windy.com/developer-mode
2. Start the dev server:
   ```bash
   cd web/windy-plugin
   bun run start
   ```
3. Open https://www.windy.com — the plugin loads automatically from `https://localhost:9999/plugin.js`

See the [Windy debugging guide](https://docs.windy-plugins.com/getting-started/debugging.html) for more detail on the dev workflow.

## Build

```bash
bun run build   # outputs dist/plugin.js and dist/plugin.min.js
```

## Architecture

This plugin consumes `@taskscore/engine` as a workspace dependency. Rollup bundles the engine's TypeScript source directly via SWC — no separate build step needed for the engine.

```
@taskscore/engine (workspace:*)
    ↓ rollup-plugin-swc3 transpiles TS
    ↓ rollup bundles into single file
dist/plugin.min.js (~32KB)
```
