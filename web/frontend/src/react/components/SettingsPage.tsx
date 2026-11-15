/**
 * SettingsPage — a page that is read, or is a list of rows that each open a
 * page: the bar (back, title, ⋯), an optional line of description, and the
 * narrow column every such page shares. One pattern at every viewport size.
 *
 * A page that is a FORM is `SettingsForm`, which carries its own bar: Cancel
 * and the commit button live there, so the form has to wrap it.
 */
import { Page, PageBar, type BarAction, type Related } from "@/react/rac/page-bar";
import type { Crumb } from "@/react/lib/crumbs";

export function SettingsPage({
  crumbs,
  title,
  fullTitle,
  description,
  actions,
  related,
  children,
}: {
  /** The pages above this one, from the builders in lib/crumbs.ts. */
  crumbs: Crumb[];
  /** One line: the bar's title and the page's `<h1>`. */
  title: string;
  /** The name in full, where the title is a short form of it. */
  fullTitle?: string;
  description?: React.ReactNode;
  /** The page's actions, under ⋯. */
  actions?: BarAction[];
  /** The pages beside or under this one, in the title's menu. */
  related?: Related;
  children: React.ReactNode;
}) {
  return (
    <Page
      bar={
        <PageBar
          title={title}
          fullTitle={fullTitle}
          trail={crumbs}
          actions={actions}
          related={related}
        />
      }
      className="flex flex-col gap-6"
    >
      {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      {children}
    </Page>
  );
}
