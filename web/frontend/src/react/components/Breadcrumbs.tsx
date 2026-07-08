/**
 * Breadcrumb trail of parent pages. The current page is deliberately NOT a
 * crumb: every page renders its own name as the H1 directly beneath, so the
 * trail lists ancestors only (the GOV.UK-style "up links" convention). Keep
 * labels short and identical wherever the same destination appears.
 */
import { Fragment } from "react";
import { Link } from "react-router-dom";

export function Breadcrumbs({ items }: { items: Array<{ label: string; to: string }> }) {
  return (
    <nav aria-label="Breadcrumb" className="text-sm">
      {items.map((item, i) => (
        <Fragment key={item.to}>
          {i > 0 ? <> › </> : null}
          <Link className="underline underline-offset-4" to={item.to}>
            {item.label}
          </Link>
        </Fragment>
      ))}
    </nav>
  );
}
