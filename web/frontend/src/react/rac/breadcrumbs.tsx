/**
 * Breadcrumb trail of parent pages. Matches components/Breadcrumbs.tsx: the
 * current page is deliberately NOT a crumb — every page renders its own name as
 * the H1 directly beneath, so the trail lists ancestors only (GOV.UK-style "up
 * links"). Every crumb is therefore a navigable link.
 *
 * Note: we render a plain <ol>/<li> with RAC Links rather than RAC's
 * `Breadcrumbs`/`Breadcrumb` collection. That collection hard-codes the LAST
 * item as the current page (`aria-current="page"` + a disabled link), which is
 * wrong here — the last crumb (e.g. the comp on a task page) is a parent link,
 * not the current page. RAC Links still navigate client-side through the
 * RouterProvider set up in rac/router.tsx.
 */
import { Link as AriaLink } from "react-aria-components";

export function Breadcrumbs({ items }: { items: Array<{ label: string; to: string }> }) {
  return (
    <nav aria-label="Breadcrumb" className="text-sm">
      <ol className="flex flex-wrap items-center gap-1.5">
        {items.map((item, i) => (
          <li key={item.to} className="flex items-center gap-1.5">
            {i > 0 ? <span aria-hidden>›</span> : null}
            <AriaLink
              href={item.to}
              className="rounded underline underline-offset-4 outline-none data-hovered:text-foreground data-focus-visible:ring-2 data-focus-visible:ring-ring/50"
            >
              {item.label}
            </AriaLink>
          </li>
        ))}
      </ol>
    </nav>
  );
}
