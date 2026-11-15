/**
 * PageBar — the one bar every page of the app has (issue #863).
 *
 * The page is for information; every action goes in the bar. It is stuck to
 * the top while the page scrolls, with three slots that always mean the same
 * thing:
 *
 *   leading   the way out      back to the page above · Cancel on a form · the
 *                              main menu on a top-level page
 *   centre    where you are    the page's title (its <h1>), over a menu drawn
 *                              as one tree: up to the pages above, across or
 *                              down to the pages beside or under this one, and
 *                              out to the other top-level places
 *   trailing  what you can do  a form's commit button · or ⋯ for the page's
 *                              actions, with + and a status beside it
 *
 * It is `sticky`, never `fixed` (CLAUDE.md, "No bars fixed to the screen's
 * edges"): the keyboard comes up from the bottom, so a bar at the top is never
 * under it. On an iPhone the screen pans when the keyboard opens, and the bar
 * follows it (`useKeepOnScreen`, below). Every control in it, and every row of its menus, is
 * 44 px at every pointer.
 *
 * The title is ONE line and may be cut short; the menu under it prints every
 * level in full. A page whose name is a sentence ("Copy pilots from another
 * competition") is an action: the sentence is the ⋯ row that opens it, and the
 * page has a short `title` with the sentence as `fullTitle`.
 *
 * ## What is in the markup with the menus closed
 *
 * The trail and the ⋯ rows are inside closed menus, so their links are not in
 * the server's HTML. Two visually hidden `<nav>`s carry them as real links:
 * "Breadcrumb" (the pages above, then this page as `aria-current`; the
 * accessibility standard §4.3, and the `BreadcrumbList` structured data the
 * SSR Function publishes) and "Page actions" (every ⋯ row that opens a page —
 * "Submit your track" above all). The back control is a real link to the page
 * above, so it works with JavaScript off.
 *
 * ## Server rendering
 *
 * No `window` at module scope, menus closed, and the signed-in state from
 * `useUser()` (seeded with `initialUser` on the server), so the server and the
 * client render the same bar.
 *
 * The pills are translucent, but they sit on an opaque scrim of the page's
 * ground: text on them has the same contrast whatever scrolls beneath
 * (accessibility standard §3.1). Keep the scrim.
 */
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Link as RouterLink, useLocation, useNavigate } from "react-router-dom";
import { Button as AriaButton, MenuTrigger, SubmenuTrigger } from "react-aria-components";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  EllipsisIcon,
  MenuIcon,
  PlusIcon,
  type LucideIcon,
} from "lucide-react";
import { Button, LinkButton, buttonVariants } from "./button";
import { Menu, MenuHeader, MenuItem, MenuSection, MenuSeparator } from "./menu";
import { useTabsCollectionPass } from "./tabs";
import { cn } from "@/react/lib/utils";
import { openedHere, useLeave } from "@/react/lib/leave";
import {
  DEV_SIGN_IN_ENABLED,
  signInAsDev,
  useGoToSignIn,
  useUser,
  type PreviewRole,
} from "@/react/lib/user";
import { toast } from "@/react/lib/toast";
import { signOut } from "../../auth/client";

export interface Crumb {
  label: string;
  to: string;
}

export interface BarAction {
  id: string;
  label: string;
  /** A page this opens… */
  to?: string;
  /** …a file it saves (with `to`)… */
  download?: boolean | string;
  /** …a new tab it opens in (with `to`)… */
  target?: "_blank";
  /** …or something it does here. */
  onAction?: () => void;
  destructive?: boolean;
  /** Draw a rule above this row: the start of a new group. */
  group?: boolean;
  /** Shown, but not available just now. */
  disabled?: boolean;
  /** A group of actions behind this row, opened as a second menu. */
  children?: BarAction[];
  /**
   * A line icon at the start of the row (Lucide). Every ⋯ row has one, and
   * one icon means one thing across the app (CLAUDE.md, "Every ⋯ row carries
   * a line icon"): `MapIcon` for a page that shows tracks on a map (the 3D
   * replay included), `ChartColumnIcon` for an analysis and nothing else,
   * `MountainIcon` for anything about altitudes, `Trash2Icon` for clearing,
   * and so on. In a menu where any row has one, a row without keeps an empty
   * slot, so the labels line up.
   */
  icon?: LucideIcon;
}

export interface Related {
  /**
   * How these pages stand to this one: beside it (one of them IS this page),
   * or under it. Either way they are drawn as one more level of the same tree.
   */
  as: "siblings" | "children";
  items: Array<Crumb & { current?: boolean }>;
}

/** A menu row a finger can hit: 44 px, body size, and it may wrap. */
const ROW = "min-h-11 gap-3 px-3 py-2 text-base whitespace-normal";
const HEAD = "px-3 pt-2 pb-1";
const MENU = "max-w-[calc(100vw-2rem)]";
/** The glass a floating control is made of. */
const GLASS =
  "border border-border/70 bg-card/75 shadow-card backdrop-blur-xl backdrop-saturate-150 dark:bg-card/60";
const ICON = "pointer-events-auto size-11 rounded-full";

/** Classes for a form's commit button in the trailing slot. */
// Narrower padding on a phone: a top-level title beside + and Sign in has
// 360 px to share, and "Competitions" was cut short there.
export const commitClass = "h-11 rounded-full px-4 text-[0.9375rem] sm:px-5";

/** The two widths a page's column, and its bar with it, can have. */
export type PageWidth = "narrow" | "wide";
const WIDTH: Record<PageWidth, string> = { narrow: "max-w-3xl", wide: "max-w-6xl" };
const PageWidthContext = createContext<PageWidth>("narrow");

/**
 * The bar. Under `Tabs` (a tab strip in `below`), RAC renders the page once
 * more only to collect the tabs: in that pass this is the tab strip and
 * nothing else, so there is one bar, and one `<h1>`, in the document
 * (`useTabsCollectionPass` in rac/tabs.tsx).
 */
export function PageBar(props: Parameters<typeof Bar>[0]) {
  return useTabsCollectionPass() ? <>{props.below}</> : <Bar {...props} />;
}

function Bar({
  title,
  fullTitle,
  trail = [],
  related,
  cancel,
  actions = [],
  add,
  status,
  commit,
  below,
}: {
  /** The page's name: one line, and the page's `<h1>`. */
  title: string;
  /** The name in full, where the title is a short form of it. */
  fullTitle?: string;
  /** The pages above this one, from the top (lib/crumbs.ts). None: a top-level page. */
  trail?: Crumb[];
  /** The pages beside this one, or under it, drawn in the centre menu's tree. */
  related?: Related;
  /** A form: the leading control is the word Cancel, and leaves through this. */
  cancel?: () => void;
  /** The page's actions, under ⋯. Pass only the ones this reader may use. */
  actions?: BarAction[];
  /** "Add one", beside ⋯: a page it opens, or something it does here. */
  add?: { label: string; to?: string; onAction?: () => void };
  /** Something in flight, beside ⋯: a spinner. */
  status?: ReactNode;
  /** A form's commit button: a `SubmitButton` or `Button` with {@link commitClass}. */
  commit?: ReactNode;
  /** A second layer that sticks with the bar: a search field, tabs. Nothing else. */
  below?: ReactNode;
}) {
  const leave = useLeave();
  const goToSignIn = useGoToSignIn();
  // Signing in from the bar comes back to the page it was asked from.
  const { pathname, search } = useLocation();
  const here = pathname + search;
  const { user, loading } = useUser();
  const width = WIDTH[useContext(PageWidthContext)];
  const parent = trail[trail.length - 1];
  const hasMenu = trail.length > 0 || !!related;
  const topLevel = useTopLevel();

  let leading: ReactNode;
  if (cancel) {
    leading = (
      <Button
        variant="ghost"
        onPress={cancel}
        className={cn("pointer-events-auto h-11 rounded-full px-4 text-[0.9375rem]", GLASS)}
      >
        Cancel
      </Button>
    );
  } else if (parent) {
    // A real link, so it works with JavaScript off and a crawler can follow
    // it. With JavaScript it is `leave()`: a real Back when a page of ours
    // opened this one, else a replace with the page above (lib/leave.ts).
    const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      leave(parent.to);
    };
    leading = (
      <RouterLink
        to={parent.to}
        aria-label={`Back to ${parent.label}`}
        // Read by the unsaved-changes guard: this is Back, and Back never asks.
        data-bar-back
        onClick={onClick}
        className={cn(
          buttonVariants({ variant: "ghost", size: "icon" }),
          ICON,
          GLASS,
          "hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        )}
      >
        <ChevronLeftIcon className="size-5" aria-hidden />
      </RouterLink>
    );
  } else {
    leading = <MainMenu className={cn(ICON, GLASS)} />;
  }

  const centre = (
    <div
      className={cn(
        "pointer-events-auto relative flex h-11 min-w-0 flex-1 flex-col justify-center rounded-full px-3 text-center sm:px-4",
        GLASS
      )}
    >
      <h1 className="truncate text-[0.9375rem] leading-5 font-semibold">{title}</h1>
      {hasMenu ? (
        <>
          <p
            aria-hidden
            className="flex min-w-0 items-center justify-center gap-0.5 text-xs leading-4 text-muted-foreground"
          >
            {/* A phone has room for the parent; a wider screen for the trail. */}
            <span className="truncate sm:hidden">
              {parent
                ? `${parent.label}${trail.length > 1 ? ` +${trail.length - 1} more` : ""}`
                : "Pages"}
            </span>
            <span className="truncate max-sm:hidden">
              {trail.length > 0 ? trail.map((c) => c.label).join(" › ") : "Pages"}
            </span>
            <ChevronDownIcon className="size-3 shrink-0" />
          </p>
          <MenuTrigger>
            <AriaButton
              aria-label={`${fullTitle ?? title}: go to another page`}
              className="absolute -inset-px rounded-full outline-none data-focus-visible:ring-3 data-focus-visible:ring-ring/50 data-pressed:bg-foreground/5"
            />
            <Menu placement="bottom" className={cn(MENU, "min-w-64")}>
              <MenuSection>
                <MenuHeader className={HEAD}>You are here</MenuHeader>
                {trail.map((c, i) => (
                  <MenuItem
                    key={`${i}-${c.to}`}
                    href={c.to}
                    className={ROW}
                    style={{ paddingLeft: 12 + i * 14 }}
                  >
                    {c.label}
                  </MenuItem>
                ))}
                {related?.as === "siblings" ? null : (
                  <MenuItem
                    id="current"
                    isDisabled
                    className={cn(ROW, "font-semibold data-disabled:opacity-100")}
                    style={{ paddingLeft: 12 + trail.length * 14 }}
                  >
                    <span className="min-w-0 flex-1">{fullTitle ?? title}</span>
                    <CheckIcon className="size-4 shrink-0 text-link" aria-hidden />
                  </MenuItem>
                )}
                {(related?.items ?? []).map((it) => (
                  <MenuItem
                    key={it.to}
                    href={it.current ? undefined : it.to}
                    isDisabled={it.current}
                    className={cn(ROW, it.current && "font-semibold data-disabled:opacity-100")}
                    style={{
                      paddingLeft:
                        12 + (trail.length + (related?.as === "children" ? 1 : 0)) * 14,
                    }}
                  >
                    <span className="min-w-0 flex-1">{it.label}</span>
                    {it.current ? (
                      <CheckIcon className="size-4 shrink-0 text-link" aria-hidden />
                    ) : null}
                  </MenuItem>
                ))}
              </MenuSection>
              <MenuSeparator />
              <MenuSection>
                <MenuHeader className={HEAD}>Elsewhere</MenuHeader>
                {/* The trail already starts at one of these. */}
                {topLevel
                  .filter((c) => c.to !== trail[0]?.to)
                  .map((c) => (
                    <MenuItem key={c.to} href={c.to} className={ROW}>
                      {c.label}
                    </MenuItem>
                  ))}
                {/* A reader three pages deep is one menu from signing in. */}
                {!user && !loading ? (
                  <MenuItem id="sign-in" className={ROW} onAction={() => goToSignIn(here)}>
                    Sign in
                  </MenuItem>
                ) : null}
              </MenuSection>
            </Menu>
          </MenuTrigger>
        </>
      ) : null}
    </div>
  );

  const hasGroup = !!status || !!add || actions.length > 0;
  const trailing = (
    <div className="pointer-events-auto flex shrink-0 items-center gap-2">
      {hasGroup ? (
        <div className={cn("flex h-11 items-center rounded-full", GLASS)}>
          {status ? (
            <span className="flex size-11 items-center justify-center">{status}</span>
          ) : null}
          {add?.to ? (
            <LinkButton
              href={add.to}
              routerOptions={openedHere()}
              variant="ghost"
              size="icon"
              aria-label={add.label}
              className="size-11 rounded-full"
            >
              <PlusIcon className="size-5" />
            </LinkButton>
          ) : add ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label={add.label}
              onPress={add.onAction}
              className="size-11 rounded-full"
            >
              <PlusIcon className="size-5" />
            </Button>
          ) : null}
          {actions.length > 0 ? (
            <MenuTrigger>
              <Button
                variant="ghost"
                size="icon"
                aria-label="More actions"
                className="size-11 rounded-full"
              >
                <EllipsisIcon className="size-5" />
              </Button>
              <Menu placement="bottom end" className={cn(MENU, "min-w-56")}>
                {menuItems(actions)}
              </Menu>
            </MenuTrigger>
          ) : null}
        </div>
      ) : null}
      {commit}
      {/* Signed out, a top-level page has Sign in where a page's main action is. */}
      {!cancel && !parent && !commit && !user && !loading ? (
        <Button className={commitClass} onPress={() => goToSignIn(here)}>
          Sign in
        </Button>
      ) : null}
    </div>
  );

  const linkActions = flatten(actions).filter((a) => a.to && !a.disabled);
  const headerRef = useKeepOnScreen();

  return (
    <header
      ref={headerRef}
      className="pointer-events-none sticky top-0 z-40 pt-safe [@media(max-height:500px)]:static print:hidden"
    >
      {/* Under the floating controls the page fades out as it scrolls beneath. */}
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 -bottom-3 bg-linear-to-b from-background from-70% to-background/0"
      />
      <div className={cn("relative mx-auto flex w-full items-center gap-2 px-gutter-safe py-2", width)}>
        {leading}
        {centre}
        {trailing}
      </div>
      {below ? (
        <div className={cn("pointer-events-auto relative mx-auto w-full px-gutter-safe pb-2", width)}>
          {below}
        </div>
      ) : null}
      {/* The closed menus' links, as real links in the markup (see the note
          at the top). Out of the Tab order: the menus are the way to them by
          keyboard, and a hidden link must not take focus where nobody can see
          it (WCAG 2.4.7). */}
      {trail.length > 0 ? (
        <nav aria-label="Breadcrumb" className="sr-only">
          <ol>
            {trail.map((c, i) => (
              <li key={`${i}-${c.to}`}>
                <RouterLink to={c.to} tabIndex={-1}>
                  {c.label}
                </RouterLink>
              </li>
            ))}
            <li>
              <span aria-current="page">{fullTitle ?? title}</span>
            </li>
          </ol>
        </nav>
      ) : null}
      {linkActions.length > 0 ? (
        <nav aria-label="Page actions" className="sr-only">
          <ul>
            {linkActions.map((a) => (
              <li key={a.id}>
                <a
                  href={a.to}
                  tabIndex={-1}
                  download={a.download}
                  target={a.target}
                  rel={a.target ? "noopener noreferrer" : undefined}
                >
                  {a.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </header>
  );
}

/**
 * Keeps the bar on screen while an iPhone's keyboard is up.
 *
 * The bar is `sticky`, which sticks it to the top of the LAYOUT viewport. When
 * the keyboard opens, iOS Safari does not shrink that viewport or scroll the
 * page: it pans the VISUAL viewport down inside it to bring the focused field
 * above the keyboard. Everything stuck to the top of the page goes off the top
 * of the screen with it, and on a form that is Cancel and Save (found on the
 * simulators for issue #863; a field in the lower half of any form does it).
 *
 * So the bar follows the visual viewport: shifted down by exactly as far as
 * the screen has panned, and by nothing the rest of the time. It is the one
 * place the app positions anything from script, and it is deliberately the
 * smallest thing that works: one transform, from one number the browser
 * reports, with no keyboard height, no guess at when the keyboard opened and
 * nothing fixed to the screen. On every other browser the offset is always 0.
 */
/** Shorter than any on-screen keyboard, taller than a browser toolbar that hides and shows. */
const KEYBOARD_MIN_HEIGHT = 150;

function useKeepOnScreen() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    const el = ref.current;
    if (!viewport || !el) return;
    const follow = () => {
      // Only while the keyboard is up, which is when the visual viewport is
      // shorter than the layout one. Safari also reports an offset while the
      // page is dragged past its end and springs back, with the viewport at
      // full height; following that moved the bar down the screen by the
      // length of the drag. Pinch-zoom pans the visual viewport too; the bar
      // stays with the page then.
      const keyboardUp = window.innerHeight - viewport.height > KEYBOARD_MIN_HEIGHT;
      const top = keyboardUp && viewport.scale === 1 ? Math.max(0, viewport.offsetTop) : 0;
      el.style.transform = top > 0 ? `translateY(${top}px)` : "";
    };
    follow();
    viewport.addEventListener("resize", follow);
    viewport.addEventListener("scroll", follow);
    return () => {
      viewport.removeEventListener("resize", follow);
      viewport.removeEventListener("scroll", follow);
      el.style.transform = "";
    };
  }, []);
  return ref;
}

function flatten(actions: BarAction[]): BarAction[] {
  return actions.flatMap((a) => (a.children ? flatten(a.children) : [a]));
}

/** The rows of an actions menu: rules between groups, a second menu behind a row with children. */
/** A row's icon, or the empty slot that keeps its label in line with one. */
function RowIcon({ icon: Icon, destructive }: { icon?: LucideIcon; destructive?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-5 shrink-0 items-center justify-center",
        // A destructive row is red throughout, its icon included.
        destructive ? "text-current" : "text-muted-foreground"
      )}
    >
      {Icon ? <Icon className="size-5" /> : null}
    </span>
  );
}

function menuItems(actions: BarAction[]): ReactNode[] {
  const items: ReactNode[] = [];
  // Only a menu that has an icon makes room for one on every row.
  const slot = actions.some((a) => a.icon);
  for (const a of actions) {
    if (a.group && items.length > 0) items.push(<MenuSeparator key={`${a.id}-rule`} />);
    if (a.children) {
      items.push(
        <SubmenuTrigger key={a.id}>
          <MenuItem id={a.id} className={ROW}>
            {slot ? <RowIcon icon={a.icon} /> : null}
            <span className="min-w-0 flex-1">{a.label}</span>
            <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </MenuItem>
          {/* Below the row, not beside it: a phone has no room beside. */}
          <Menu placement="bottom end" className={cn(MENU, "min-w-56")}>
            {menuItems(a.children)}
          </Menu>
        </SubmenuTrigger>
      );
      continue;
    }
    items.push(
      <MenuItem
        key={a.id}
        id={a.id}
        href={a.to}
        download={a.download}
        target={a.target}
        rel={a.target ? "noopener noreferrer" : undefined}
        routerOptions={a.to && !a.download && !a.target ? openedHere() : undefined}
        onAction={a.onAction}
        isDisabled={a.disabled}
        className={cn(ROW, a.destructive && "text-danger data-focused:text-danger")}
      >
        {slot ? <RowIcon icon={a.icon} destructive={a.destructive} /> : null}
        {slot ? <span className="min-w-0 flex-1">{a.label}</span> : a.label}
      </MenuItem>
    );
  }
  return items;
}

/** The places the app starts from. My Flights is the signed-in reader's own page. */
function useTopLevel(): Crumb[] {
  const { user } = useUser();
  return [
    { label: "Competitions", to: "/comp" },
    { label: "My Flights", to: user?.username ? `/u/${user.username}` : "/u/me" },
    { label: "Submit track", to: "/submit" },
  ];
}

const PREVIEW_ROLES: Array<{ role: PreviewRole; label: string }> = [
  { role: "out", label: "Signed out" },
  { role: "pilot", label: "Pilot" },
  { role: "admin", label: "Comp admin" },
  { role: "actual", label: "Super admin" },
];

/**
 * A top-level page's leading control: the places the app starts from, and the
 * account. A site super admin also has "Preview as" here: a presentation-only
 * preview of the signed-out, pilot and comp-admin experience (the API still
 * sees the real session). It was a pill fixed to the screen's corner, over
 * whatever the page had there (#858).
 */
function MainMenu({ className }: { className: string }) {
  const { user, loading, isSuperAdmin, previewRole, setPreviewRole } = useUser();
  const goToSignIn = useGoToSignIn();
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const here = pathname + search;
  const topLevel = useTopLevel();
  const previewing = PREVIEW_ROLES.find(({ role }) => role === previewRole);
  const previewAs = isSuperAdmin ? (
    <SubmenuTrigger>
      <MenuItem id="preview-as" className={ROW}>
        <span className="min-w-0 flex-1">
          Preview as{previewRole !== "actual" && previewing ? `: ${previewing.label}` : ""}
        </span>
        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </MenuItem>
      <Menu placement="bottom start" className={cn(MENU, "min-w-56")}>
        <MenuSection aria-label="Preview as">
          {PREVIEW_ROLES.map(({ role, label }) => (
            <MenuItem key={role} id={role} className={ROW} onAction={() => setPreviewRole(role)}>
              <span className="min-w-0 flex-1">{label}</span>
              {role === previewRole ? (
                <CheckIcon className="size-4 shrink-0 text-link" aria-label="Selected" />
              ) : null}
            </MenuItem>
          ))}
        </MenuSection>
      </Menu>
    </SubmenuTrigger>
  ) : null;

  return (
    <MenuTrigger>
      <Button variant="ghost" size="icon" aria-label="Main menu" className={className}>
        <MenuIcon className="size-5" />
      </Button>
      <Menu placement="bottom start" className={cn(MENU, "min-w-60")}>
        <MenuSection>
          <MenuHeader className={HEAD}>GlideComp</MenuHeader>
          {/* Home is a static page: the router bridge loads it for real. */}
          <MenuItem href="/" className={ROW}>
            Home
          </MenuItem>
          {topLevel.map((c) => (
            <MenuItem key={c.to} href={c.to} className={ROW}>
              {c.label}
            </MenuItem>
          ))}
        </MenuSection>
        <MenuSeparator />
        {user ? (
          <MenuSection>
            <MenuHeader className={cn(HEAD, "max-w-64 truncate")}>
              {user.name ?? user.email ?? "Account"}
            </MenuHeader>
            <MenuItem href="/settings" className={ROW}>
              Settings
            </MenuItem>
            {previewAs}
            <MenuItem
              id="sign-out"
              className={ROW}
              onAction={async () => {
                await signOut();
                navigate("/");
                window.location.reload();
              }}
            >
              Sign out
            </MenuItem>
          </MenuSection>
        ) : loading ? null : (
          <MenuSection aria-label="Account">
            <MenuItem id="sign-in" className={ROW} onAction={() => goToSignIn(here)}>
              Sign in
            </MenuItem>
            {DEV_SIGN_IN_ENABLED ? (
              <MenuItem
                id="sign-in-dev"
                className={ROW}
                onAction={async () => {
                  const { error } = await signInAsDev();
                  if (error) toast.error(error);
                }}
              >
                Sign in (dev)
              </MenuItem>
            ) : null}
            {previewAs}
          </MenuSection>
        )}
      </Menu>
    </MenuTrigger>
  );
}

/**
 * A page: its bar, then its content in the app's gutter. `wide` is for a page
 * that holds a table or a map beside a list (scores, a task); everything else
 * is the narrow column. The bar is as wide as the column under it.
 *
 * `fill` is a page that is one thing with the screen to itself (a map at full
 * size): the content is the rest of the screen under the bar, and the page
 * does not scroll, so every drag belongs to what fills it.
 */
export function Page({
  bar,
  width = "narrow",
  fill = false,
  className,
  children,
}: {
  bar: ReactNode;
  width?: PageWidth;
  fill?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <PageWidthContext.Provider value={width}>
      {bar}
      <div
        data-page-fill={fill || undefined}
        className={cn(
          "mx-auto w-full",
          WIDTH[width],
          fill
            ? // The bar's height (44 px and its padding), then the rest of the screen.
              "flex h-[calc(100dvh-3.75rem-env(safe-area-inset-top,0px))] flex-col pb-safe"
            : "px-gutter-safe pt-3 pb-12",
          className
        )}
      >
        {children}
      </div>
    </PageWidthContext.Provider>
  );
}
