# Basecoat Fork

We use a forked version of [Basecoat](https://basecoatui.com/) published as `@pokle/basecoat` on npm.

- **Upstream:** https://github.com/hunvreus/basecoat
- **Fork:** https://github.com/pokle/basecoat (branch: `development`)
- **npm package:** https://www.npmjs.com/package/@pokle/basecoat

## Why a fork?

The fork contains a bug fix that hasn't been merged upstream yet. Once the upstream maintainer merges the fix, we can switch back to the original `basecoat-css` package.

## How to build and publish

From the fork's local checkout (`~/dev/basecoat-pokle` or wherever you have it):

```bash
# 1. Install dependencies
npm install

# 2. Build the CSS and JS dist files
npm run build

# 3. Publish the whole monorepo package
npm publish --access public
```

Make sure to bump the version in `package.json` before publishing a new release.

## Switching back to upstream

When the fix is merged upstream, update `web/frontend/package.json`:

```diff
- "@pokle/basecoat": "0.3.10-beta3.pokle-selections",
+ "basecoat-css": "^0.4.0",
```

And update the import paths in:
- `web/frontend/src/styles.css` — `@import "@pokle/basecoat/src/css/basecoat.css"` → `@import "basecoat-css"`
- `web/frontend/src/analysis/main.ts` — `@pokle/basecoat/src/js/...` → `basecoat-css/...`
