/** About page — React port of about.html. */
import { useEffect } from "react";
import { Link } from "react-router-dom";

export function About() {
  useEffect(() => {
    document.title = "GlideComp - About";
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground p-6 bg-hills">
      <div className="max-w-2xl mx-auto">
        <header className="mb-10">
          <Link
            to="/"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
            Back
          </Link>
          <h1 className="text-3xl font-bold flex items-center gap-3">
            <img src="/icon.svg" alt="GlideComp logo" className="w-8 h-8" />
            About GlideComp
          </h1>
        </header>

        <h2 className="text-xl font-semibold mb-4">About me</h2>
        <section className="mb-10 space-y-4">
          <p>I want to learn from better pilots, and ultimately out compete them!</p>
          <p>
            Gliding competitions are a unique experience where you can fly in the same air as the
            best pilots in the world. After the day's task, you can talk to them, and analyse their
            flight data.
          </p>
          <p>
            I built GlideComp to figure out which line they took, how fast they flew, how well they
            climbed, and ultimately how they scored in the task!
          </p>
          <p className="text-sm text-muted-foreground mt-2">— Tushar Pokle (Summer 2026)</p>
        </section>

        <h2 className="text-xl font-semibold mb-4">About the tooling</h2>
        <p className="text-muted-foreground mb-6">
          GlideComp would not have been possible without these libraries, tools and resources
        </p>

        <section className="mb-10">
          <h2 className="text-xl font-semibold mb-4">Mapping &amp; Geospatial</h2>
          <ul className="space-y-3">
            <li>
              <a
                href="https://github.com/mapbox/mapbox-gl-js"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium hover:underline"
              >
                Mapbox GL JS
              </a>
              <span className="text-muted-foreground"> — Interactive vector maps</span>
            </li>
            <li>
              <a
                href="https://github.com/Leaflet/Leaflet"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium hover:underline"
              >
                Leaflet
              </a>
              <span className="text-muted-foreground"> — Lightweight map library</span>
            </li>
            <li>
              <a
                href="https://github.com/Turfjs/turf"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium hover:underline"
              >
                Turf.js
              </a>
              <span className="text-muted-foreground">
                {" "}
                — Geospatial analysis (distance, bearing, bounding boxes)
              </span>
            </li>
            <li>
              <a
                href="https://github.com/peterqliu/threebox"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium hover:underline"
              >
                Threebox
              </a>
              <span className="text-muted-foreground"> — Three.js integration for Mapbox GL</span>
            </li>
          </ul>
        </section>

        <section className="mb-10">
          <h2 className="text-xl font-semibold mb-4">3D &amp; Rendering</h2>
          <ul className="space-y-3">
            <li>
              <a
                href="https://github.com/mrdoob/three.js"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium hover:underline"
              >
                Three.js
              </a>
              <span className="text-muted-foreground"> — 3D graphics library</span>
            </li>
          </ul>
        </section>

        <section className="mb-10">
          <h2 className="text-xl font-semibold mb-4">UI &amp; Styling</h2>
          <ul className="space-y-3">
            <li>
              <a
                href="https://katex.org"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium hover:underline"
              >
                KaTeX
              </a>
              <span className="text-muted-foreground"> — Fast math typesetting</span>
            </li>
            <li>
              <a
                href="https://tailwindcss.com"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium hover:underline"
              >
                Tailwind CSS
              </a>
              <span className="text-muted-foreground"> — Utility-first CSS framework</span>
            </li>
            <li>
              <a
                href="https://ui.shadcn.com"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium hover:underline"
              >
                shadcn/ui
              </a>
              <span className="text-muted-foreground"> — UI components, built on </span>
              <a
                href="https://base-ui.com"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium hover:underline"
              >
                Base UI
              </a>
            </li>
            <li>
              <a
                href="https://github.com/fontsource/fontsource"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium hover:underline"
              >
                Fontsource / Atkinson Hyperlegible Next
              </a>
              <span className="text-muted-foreground">
                {" "}
                — Self-hosted web font designed for readability
              </span>
            </li>
          </ul>
        </section>

        <section className="mb-10">
          <h2 className="text-xl font-semibold mb-4">Backend &amp; Auth</h2>
          <ul className="space-y-3">
            <li>
              <a
                href="https://hono.dev"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium hover:underline"
              >
                Hono
              </a>
              <span className="text-muted-foreground"> — Web framework for Cloudflare Workers</span>
            </li>
            <li>
              <a
                href="https://www.better-auth.com"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium hover:underline"
              >
                Better Auth
              </a>
              <span className="text-muted-foreground"> — Authentication library</span>
            </li>
            <li>
              <a
                href="https://kysely.dev"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium hover:underline"
              >
                Kysely
              </a>
              <span className="text-muted-foreground"> — Type-safe SQL query builder</span>
            </li>
          </ul>
        </section>

        <section className="mb-10">
          <h2 className="text-xl font-semibold mb-4">Build &amp; Platform</h2>
          <ul className="space-y-3">
            <li>
              <a
                href="https://vite.dev"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium hover:underline"
              >
                Vite
              </a>
              <span className="text-muted-foreground"> — Build tool and dev server</span>
            </li>
            <li>
              <a
                href="https://www.typescriptlang.org"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium hover:underline"
              >
                TypeScript
              </a>
              <span className="text-muted-foreground"> — Typed JavaScript</span>
            </li>
            <li>
              <a
                href="https://bun.sh"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium hover:underline"
              >
                Bun
              </a>
              <span className="text-muted-foreground"> — JavaScript runtime and package manager</span>
            </li>
            <li>
              <a
                href="https://www.cloudflare.com"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium hover:underline"
              >
                Cloudflare
              </a>
              <span className="text-muted-foreground"> — Pages, Workers, and D1 hosting</span>
            </li>
          </ul>
        </section>

        <section className="mb-10">
          <h2 className="text-xl font-semibold mb-4">AI</h2>
          <ul className="space-y-3">
            <li>
              <a
                href="https://claude.ai/claude-code"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium hover:underline"
              >
                Claude Code
              </a>
              <span className="text-muted-foreground"> — AI coding assistant by Anthropic</span>
            </li>
          </ul>
        </section>

        <section className="mb-10">
          <h2 className="text-xl font-semibold mb-4">Design Resources</h2>
          <ul className="space-y-3">
            <li>
              <a
                href="https://www.svgbackgrounds.com/set/free-svg-backgrounds-and-patterns/"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium hover:underline"
              >
                Free SVG Backgrounds and Patterns by SVGBackgrounds.com
              </a>
              <span className="text-muted-foreground"> — SVG background patterns</span>
            </li>
          </ul>
        </section>

        <footer className="pt-6 border-t border-border text-sm text-muted-foreground flex items-center gap-4">
          <a
            href="https://github.com/pokle/glidecomp"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
            </svg>
            GlideComp on GitHub
          </a>
          <Link to="/scoring" className="hover:text-foreground transition-colors">
            Scoring
          </Link>
          <Link to="/legal" className="hover:text-foreground transition-colors">
            Privacy &amp; Terms
          </Link>
        </footer>
      </div>
    </div>
  );
}
