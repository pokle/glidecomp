/**
 * "On this page" table of contents for long pages, after the react-aria
 * docs pattern (react-aria.adobe.com):
 *
 * - Wide screens (xl+): a persistent left rail rendered as a grid column by
 *   the page. Every entry carries a left rule — invisible at rest over the
 *   list's faint full-height rail, dim on hover, and a contrasty
 *   foreground-coloured rule on the section you are in (scroll-tracked, not
 *   just click-tracked).
 * - Narrow screens: nothing until you scroll down a little, then a fixed
 *   bar takes over the top of the viewport (covering the app header, which
 *   is what "taken over" means in the reference design) holding a select of
 *   the sections; picking one scrolls to it.
 *
 * Semantics: the rail is a `<nav>` of anchor links — a TOC is navigation —
 * with `aria-current="location"` on the active entry. The mobile control is
 * a real labelled select.
 *
 * Entries may carry `onBeforeScroll`, which runs before scrolling — the
 * field-analysis page uses it to expand a collapsed family Disclosure so the
 * link never scrolls to a closed drawer. After the smooth scroll, focus
 * moves to the target (or its first focusable child), so keyboard users
 * land where they navigated, not back at the control.
 */
import { useEffect, useMemo, useState } from "react";
import { SimpleSelect } from "@/react/rac/select";
import { cn } from "@/react/lib/utils";

export interface PageTocItem {
  /** DOM id of the target element. */
  id: string;
  label: string;
  /** Nesting level: 0 = page section, 1 = family, 2 = a chart/table block. */
  depth?: 0 | 1 | 2;
  /** Runs before scrolling (e.g. expand the disclosure the target sits in). */
  onBeforeScroll?: () => void;
}

/** The last item whose target starts above the current reading position. */
function activeItemId(items: PageTocItem[]): string | null {
  let active: string | null = null;
  for (const item of items) {
    const el = document.getElementById(item.id);
    if (!el) continue;
    if (el.getBoundingClientRect().top <= 96) active = item.id;
  }
  return active;
}

/** How far down (px) before the mobile bar takes over the header. */
const MOBILE_BAR_SCROLL_Y = 160;

export function PageToc({ items }: { items: PageTocItem[] }) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [scrolled, setScrolled] = useState(false);

  // One rAF-throttled scroll/resize listener drives both the rail's active
  // rule and the mobile bar's appearance.
  useEffect(() => {
    if (items.length === 0) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      setActiveId(activeItemId(items));
      setScrolled(window.scrollY > MOBILE_BAR_SCROLL_Y);
    };
    const onScroll = () => {
      if (raf === 0) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, [items]);

  const selectOptions = useMemo(
    () =>
      items.map((item) => ({
        value: item.id,
        // The select popover can't indent, so nested entries get markers.
        label: "· ".repeat(item.depth ?? 0) + item.label,
      })),
    [items]
  );

  function go(item: PageTocItem) {
    setActiveId(item.id);
    item.onBeforeScroll?.();
    // Two frames: one for React to commit, one for a just-expanded
    // disclosure panel to exist before we measure and scroll to it.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const el = document.getElementById(item.id);
        if (!el) return;
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        const target = el.matches("a,button,[tabindex]")
          ? el
          : (el.querySelector<HTMLElement>("a,button,[tabindex],h1,h2,h3,h4") ?? el);
        if (!target.hasAttribute("tabindex") && !target.matches("a,button")) {
          target.setAttribute("tabindex", "-1");
        }
        target.focus({ preventScroll: true });
      })
    );
  }

  if (items.length === 0) return null;

  return (
    <>
      {/* Wide screens: the persistent left rail (a grid column of the page). */}
      <nav
        aria-label="On this page"
        className="sticky top-24 hidden max-h-[calc(100vh-8rem)] self-start overflow-y-auto xl:block print:hidden"
      >
        <p className="pb-2 pl-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">
          On this page
        </p>
        {/* The faint full-height rail; each link overlays it with its own
            2px rule (transparent → dim on hover → foreground when active). */}
        <ul className="border-l border-border text-sm">
          {items.map((item) => (
            <li key={item.id}>
              <a
                href={`#${item.id}`}
                aria-current={activeId === item.id ? "location" : undefined}
                className={cn(
                  "-ml-px block border-l-2 py-1 pl-3 outline-none transition-colors",
                  "focus-visible:ring-2 focus-visible:ring-ring/50",
                  item.depth === 1 && "pl-7",
                  // Chart/table blocks: deepest indent, quieter type.
                  item.depth === 2 && "pl-11 text-[13px]",
                  activeId === item.id
                    ? "border-foreground font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground"
                )}
                onClick={(e) => {
                  e.preventDefault();
                  go(item);
                }}
              >
                {item.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      {/* Narrow screens, once scrolled: a fixed bar takes over the header
          with a section select. z-50 sits above the app header's z-40; the
          min-height matches it so nothing peeks out underneath. */}
      {scrolled ? (
        <div className="fixed inset-x-0 top-0 z-50 flex min-h-[60px] items-center border-b bg-background/95 px-4 backdrop-blur-xl xl:hidden print:hidden">
          <SimpleSelect
            ariaLabel="On this page"
            value={activeId ?? items[0].id}
            onChange={(id) => {
              const item = items.find((i) => i.id === id);
              if (item) go(item);
            }}
            options={selectOptions}
            className="w-full max-w-md"
          />
        </div>
      ) : null}
    </>
  );
}
