/**
 * React Aria Components Breadcrumbs — a real <nav><ol> trail with proper
 * link semantics. Matches components/Breadcrumbs.tsx conventions: parents
 * only (the current page is the H1 below, never a crumb).
 *
 * RAC Links navigate client-side through the RouterProvider set up in
 * rac/router.tsx.
 */
import {
  Breadcrumbs as AriaBreadcrumbs,
  Breadcrumb as AriaBreadcrumb,
  Link as AriaLink,
} from "react-aria-components";

export function Breadcrumbs({ items }: { items: Array<{ label: string; to: string }> }) {
  return (
    <nav aria-label="Breadcrumb" className="text-sm">
      <AriaBreadcrumbs className="flex flex-wrap items-center gap-1.5">
        {items.map((item, i) => (
          <AriaBreadcrumb key={item.to} className="flex items-center gap-1.5">
            {i > 0 ? <span aria-hidden>›</span> : null}
            <AriaLink
              href={item.to}
              className="rounded underline underline-offset-4 outline-none data-hovered:text-foreground data-focus-visible:ring-2 data-focus-visible:ring-ring/50"
            >
              {item.label}
            </AriaLink>
          </AriaBreadcrumb>
        ))}
      </AriaBreadcrumbs>
    </nav>
  );
}
