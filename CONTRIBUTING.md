# Contributing to GlideComp

Thanks for your interest in GlideComp! Here's how you can help.

## Ways to Contribute

### Bug Reports

Found something broken? [Open an issue](https://github.com/pokle/glidecomp/issues) with:

- What you were doing
- What you expected to happen
- What actually happened
- Your device and browser
- Screenshots or videos of the issue

### Testing

Try GlideComp on different devices, browsers, and screen sizes. Reports on mobile usability, map performance, and IGC file compatibility are especially useful.

### Ideas and Improvements

Have a feature idea or UX suggestion? Open an issue describing the problem you'd like solved. Screenshots, sketches, or references to other tools are welcome.

## A Note on Code PRs

This project is developed with AI-assisted coding (Claude Code), which means code changes are quick to implement from a good description. Instead of opening a PR with code, please open an issue with your suggestion — if it's a good fit, it can be implemented and shipped fast.

## Getting Started Locally

```bash
bun install

# A MapBox token is required — the maps are blank without it
cp .env.example .env
# Edit .env and set VITE_MAPBOX_TOKEN=your_token_here

bun run dev
```

`bun run dev` starts the Vite frontend on http://localhost:3000 and all three
API Workers in a single `wrangler dev` session behind the dev-router on
http://localhost:8790. Vite proxies `/api` there, so the browser only ever
talks to :3000.

Before opening anything, run `bun run test:all` (unit tests + typechecks
across every workspace). The end-to-end suite is `bun run test:e2e`; it needs
Playwright's browsers once (`bunx playwright install chromium`).

See the [README](README.md) — its Setup and Running locally sections cover the
`.dev.vars` the auth worker needs, seeding the sample competitions, and the
rest of the scripts.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
