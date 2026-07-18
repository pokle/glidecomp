/**
 * ARIA-native breadcrumb trail — the WAI-ARIA breadcrumb pattern
 * (https://www.w3.org/WAI/ARIA/apg/patterns/breadcrumb/): a `<nav>` wrapping an
 * ordered list of ancestor links, followed by the **current page** as the final
 * crumb, marked `aria-current="page"` and rendered as plain (non-navigable)
 * text — you're already there.
 *
 * Built on RAC's `Breadcrumbs`/`Breadcrumb` collection (the component the rest
 * of the app will adopt as it moves to react-aria-components). RAC renders the
 * `<nav><ol><li>` structure and treats the LAST `Breadcrumb` as current; we
 * give it a plain-text child (not a `Link`) so there's no self-referential link
 * to disable, and set `aria-current="page"` on that span ourselves. Parent
 * crumbs are RAC `Link`s, which client-route through the RouterProvider in
 * rac/router.tsx.
 *
 * API: `items` are the ancestor links (each navigates); `current` is the label
 * of the page you're on. Contrast the parents-only `components/Breadcrumbs.tsx`,
 * which omits the current page entirely (relying on the H1 below the trail).
 */
import {
  Breadcrumbs as AriaBreadcrumbs,
  Breadcrumb,
  Link as AriaLink,
} from "react-aria-components";

const linkClass =
  "rounded underline underline-offset-4 outline-none data-hovered:text-foreground data-focus-visible:ring-2 data-focus-visible:ring-ring/50";

export function Breadcrumbs({
  items,
  current,
}: {
  items: Array<{ label: string; to: string }>;
  current: string;
}) {
  // RAC's <Breadcrumbs> renders a bare <ol>; wrap it in a <nav> landmark so the
  // trail is exposed as an ARIA navigation region (WAI-ARIA breadcrumb pattern).
  return (
    <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
      <AriaBreadcrumbs className="flex flex-wrap items-center gap-1.5">
        {items.map((item) => (
          <Breadcrumb key={item.to} className="flex items-center gap-1.5">
            <AriaLink href={item.to} className={linkClass}>
              {item.label}
            </AriaLink>
            <span aria-hidden>›</span>
          </Breadcrumb>
        ))}
        <Breadcrumb className="flex items-center gap-1.5">
          <span aria-current="page" className="text-foreground">
            {current}
          </span>
        </Breadcrumb>
      </AriaBreadcrumbs>
    </nav>
  );
}
