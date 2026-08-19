/**
 * SettingsPage — the scaffold every hierarchical settings screen shares:
 * breadcrumb trail, title, optional description, and a centred max-width
 * column. One pattern at every viewport size — a phone gets a full-width
 * stack, a desktop gets a comfortable column — so there is no responsive
 * split to keep in step.
 *
 * The breadcrumb's parent link IS the back affordance (no separate back
 * button): these are real routes, so the browser back button walks
 * sub-page → index → comp page on its own.
 */
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import type { Crumb } from "@/react/lib/crumbs";

export function SettingsPage({
  crumbs,
  title,
  description,
  children,
}: {
  /** Ancestor links, from the builders in lib/crumbs.ts. */
  crumbs: Crumb[];
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-2xl">
      <Breadcrumbs items={crumbs} current={title} />
      <h1 className="mt-2 text-2xl font-bold">{title}</h1>
      {description ? (
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      ) : null}
      <div className="mt-6 flex flex-col gap-6">{children}</div>
    </div>
  );
}
