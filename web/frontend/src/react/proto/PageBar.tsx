/**
 * PageBar — PROTOTYPE, used only by the pages under /proto.
 *
 * One bar on every page, stuck to the top while the page scrolls, with three
 * slots that always mean the same thing:
 *
 *   leading   the way out      back to the parent · Cancel on a form · the
 *                              main menu on a top-level page
 *   centre    where you are    the page's title (its <h1>), over a menu that
 *                              goes up the hierarchy, across to its siblings,
 *                              and out to the top-level places
 *   trailing  what you can do  the form's commit button · or ⋯ for the page's
 *                              actions, with a + and a status beside it
 *
 * It is `sticky`, never `fixed` (CLAUDE.md, "No bars fixed to the screen's
 * edges"): a bar stuck to the top never meets the keyboard, so nothing here
 * moves itself around one. Every control is 44 px.
 *
 * The title is ONE line and may be cut short; the menu under it prints every
 * level in full. A page whose name is a sentence ("Copy pilots from another
 * competition") is an action: the sentence is the label of the ⋯ item that
 * opens it, where there is room for it, and the page itself has a short title
 * with the sentence as `fullTitle`.
 */
import type { ReactNode } from "react";
import { Button as AriaButton, MenuTrigger, SubmenuTrigger } from "react-aria-components";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  EllipsisIcon,
  MenuIcon,
  PlusIcon,
} from "lucide-react";
import { Button, LinkButton } from "@/react/rac/button";
import { Menu, MenuHeader, MenuItem, MenuSection, MenuSeparator } from "@/react/rac/menu";
import { cn } from "@/react/lib/utils";
import { openedHere, useLeave } from "../lib/leave";
import { P } from "./fixtures";
import { useProtoOptions } from "./options";

export interface Crumb {
  label: string;
  to: string;
}

export interface BarAction {
  id: string;
  label: string;
  /** A page this opens… */
  to?: string;
  /** …or something it does here. */
  onAction?: () => void;
  destructive?: boolean;
  /** Draw a rule above this item: the start of a new group. */
  group?: boolean;
  /** For organisers: left out for a reader who is signed out. */
  admin?: boolean;
  /** Shown, but not available just now. */
  disabled?: boolean;
  /** A group of actions behind this row, opened as a second menu. */
  children?: BarAction[];
}

export interface Related {
  /**
   * How these pages stand to this one: beside it (one of them IS this page),
   * or under it. Either way they are drawn as one more level of the same tree.
   */
  as: "siblings" | "children";
  items: Array<Crumb & { current?: boolean }>;
}

/** The three places the app starts from. */
export const TOP_LEVEL: Crumb[] = [
  { label: "Competitions", to: `${P}/comp` },
  { label: "My Flights", to: `${P}/me` },
  { label: "Submit track", to: `${P}/submit` },
];

/** A menu row a finger can hit: 44 px, body size, and it may wrap. */
const ROW = "min-h-11 gap-3 px-3 py-2 text-base whitespace-normal";
const HEAD = "px-3 pt-2 pb-1";
/** Classes that bring kit controls in the bar's second layer up to 44 px. */
export const searchClass = "[&_input]:h-full";
export const tabsClass = "h-[3.1875rem]";
export const tabClass = "px-5 text-base";
/** The glass a floating control is made of. */
const GLASS =
  "border border-border/70 bg-card/75 shadow-card backdrop-blur-xl backdrop-saturate-150 dark:bg-card/60";
const ICON = "pointer-events-auto size-11 rounded-full";

/** Classes for a form's commit button in the trailing slot. */
export const commitClass = "h-11 rounded-full px-5 text-[0.9375rem]";

/**
 * Done, in the trailing slot. Done writes nothing to the server: it finishes
 * one part of a draft that its page saves later, or leaves a mode. So it is
 * never the prominent button (the wording rule in issue #863) and is drawn
 * like Cancel, with Back or Cancel always in the leading slot beside it.
 * `submit` runs the form's checks first.
 */
export function DoneButton({ submit, onPress }: { submit?: boolean; onPress?: () => void }) {
  const { options } = useProtoOptions();
  const solid = options.chrome === "solid";
  return (
    <Button
      type={submit ? "submit" : "button"}
      variant={solid ? "outline" : "ghost"}
      onPress={onPress}
      className={cn("h-11 rounded-full px-4 text-[0.9375rem]", !solid && GLASS)}
    >
      Done
    </Button>
  );
}

export function PageBar({
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
  /** The pages above this one, from the top. None: a top-level page. */
  trail?: Crumb[];
  /** The pages beside this one, or under it, drawn in the centre menu's tree. */
  related?: Related;
  /** A form: the leading control leaves it through this. */
  cancel?: () => void;
  /** The page's actions, under ⋯. */
  actions?: BarAction[];
  /** "Add one", beside ⋯. */
  add?: { label: string; to: string };
  /** Something in flight, beside ⋯: a spinner. */
  status?: ReactNode;
  /** A form's commit button. */
  commit?: ReactNode;
  /** A second layer that sticks with the bar: a search field, tabs. */
  below?: ReactNode;
}) {
  const { options, setOption } = useProtoOptions();
  const leave = useLeave();
  const solid = options.chrome === "solid";
  const surface = solid ? "" : GLASS;
  const parent = trail[trail.length - 1];
  const shown = actions.filter((a) => options.signedIn || !a.admin);
  const hasMenu = trail.length > 0 || !!related;

  let leading: ReactNode;
  if (cancel) {
    leading =
      options.formLeading === "cancel" ? (
        <Button
          variant="ghost"
          onPress={cancel}
          className={cn("pointer-events-auto h-11 rounded-full px-4 text-[0.9375rem]", surface)}
        >
          Cancel
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="icon"
          aria-label="Cancel"
          onPress={cancel}
          className={cn(ICON, surface)}
        >
          <ChevronLeftIcon className="size-5" />
        </Button>
      );
  } else if (parent) {
    leading = (
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Back to ${parent.label}`}
        onPress={() => leave(parent.to)}
        className={cn(ICON, surface)}
      >
        <ChevronLeftIcon className="size-5" />
      </Button>
    );
  } else {
    leading = <MainMenu className={cn(ICON, surface)} />;
  }

  const centre = (
    <div
      className={cn(
        "pointer-events-auto relative flex h-11 min-w-0 flex-1 flex-col justify-center rounded-full px-4 text-center",
        surface
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
            <Menu placement="bottom" className="max-w-[calc(100vw-2rem)] min-w-64">
              <MenuSection>
                <MenuHeader className={HEAD}>You are here</MenuHeader>
                {trail.map((c, i) => (
                  <MenuItem
                    key={c.to}
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
                    <CheckIcon className="size-4 shrink-0 text-primary" aria-hidden />
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
                      <CheckIcon className="size-4 shrink-0 text-primary" aria-hidden />
                    ) : null}
                  </MenuItem>
                ))}
              </MenuSection>
              <MenuSeparator />
              <MenuSection>
                <MenuHeader className={HEAD}>Elsewhere</MenuHeader>
                {/* The trail already starts at one of these. */}
                {TOP_LEVEL.filter((c) => c.to !== trail[0]?.to).map((c) => (
                  <MenuItem key={c.to} href={c.to} className={ROW}>
                    {c.label}
                  </MenuItem>
                ))}
              </MenuSection>
            </Menu>
          </MenuTrigger>
        </>
      ) : null}
    </div>
  );

  const actionItems = menuItems(shown);

  const hasGroup = !!status || !!add || shown.length > 0;
  const trailing = (
    <div className="pointer-events-auto flex shrink-0 items-center gap-2">
      {hasGroup ? (
        <div className={cn("flex h-11 items-center rounded-full", surface)}>
          {status ? (
            <span className="flex size-11 items-center justify-center">{status}</span>
          ) : null}
          {add ? (
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
          ) : null}
          {shown.length > 0 ? (
            <MenuTrigger>
              <Button
                variant="ghost"
                size="icon"
                aria-label="More actions"
                className="size-11 rounded-full"
              >
                <EllipsisIcon className="size-5" />
              </Button>
              <Menu placement="bottom end" className="max-w-[calc(100vw-2rem)] min-w-56">
                {actionItems}
              </Menu>
            </MenuTrigger>
          ) : null}
        </div>
      ) : null}
      {commit}
      {/* Signed out, a top-level page keeps Sign in where it is today. */}
      {!cancel && !parent && !options.signedIn ? (
        <Button className={commitClass} onPress={() => setOption("signedIn", true)}>
          Sign in
        </Button>
      ) : null}
    </div>
  );

  return (
    <header
      className={cn(
        "sticky top-0 z-40 pt-safe [@media(max-height:500px)]:static print:hidden",
        solid
          ? "border-b bg-background/80 backdrop-blur-xl backdrop-saturate-150"
          : "pointer-events-none"
      )}
    >
      {/* Under floating controls the page fades out as it scrolls beneath. */}
      {solid ? null : (
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 -bottom-3 bg-linear-to-b from-background from-70% to-background/0"
        />
      )}
      <div className="relative mx-auto flex w-full max-w-3xl items-center gap-2 px-gutter-safe py-2">
        {leading}
        {centre}
        {trailing}
      </div>
      {below ? (
        <div className="pointer-events-auto relative mx-auto w-full max-w-3xl px-gutter-safe pb-2">
          {below}
        </div>
      ) : null}
    </header>
  );
}

/** The rows of an actions menu: rules between groups, a second menu behind a row with children. */
function menuItems(actions: BarAction[]): ReactNode[] {
  const items: ReactNode[] = [];
  for (const a of actions) {
    if (a.group && items.length > 0) items.push(<MenuSeparator key={`${a.id}-rule`} />);
    if (a.children) {
      items.push(
        <SubmenuTrigger key={a.id}>
          <MenuItem id={a.id} className={ROW}>
            <span className="min-w-0 flex-1">{a.label}</span>
            <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </MenuItem>
          {/* Below the row, not beside it: a phone has no room beside. */}
          <Menu placement="bottom end" className="max-w-[calc(100vw-2rem)] min-w-56">
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
        routerOptions={a.to ? openedHere() : undefined}
        onAction={a.onAction}
        isDisabled={a.disabled}
        className={cn(ROW, a.destructive && "text-destructive data-focused:text-destructive")}
      >
        {a.label}
      </MenuItem>
    );
  }
  return items;
}

/** A top-level page's leading control: the places the app starts from, and the account. */
function MainMenu({ className }: { className: string }) {
  const { options, setOption } = useProtoOptions();
  return (
    <MenuTrigger>
      <Button variant="ghost" size="icon" aria-label="Main menu" className={className}>
        <MenuIcon className="size-5" />
      </Button>
      <Menu placement="bottom start" className="min-w-60">
        <MenuSection>
          <MenuHeader className={HEAD}>GlideComp</MenuHeader>
          {TOP_LEVEL.map((c) => (
            <MenuItem key={c.to} href={c.to} className={ROW}>
              {c.label}
            </MenuItem>
          ))}
        </MenuSection>
        <MenuSeparator />
        {options.signedIn ? (
          <MenuSection>
            <MenuHeader className={HEAD}>Alex Organiser</MenuHeader>
            <MenuItem className={ROW}>Settings</MenuItem>
            <MenuItem className={ROW} onAction={() => setOption("signedIn", false)}>
              Sign out
            </MenuItem>
          </MenuSection>
        ) : (
          <MenuSection aria-label="Account">
            <MenuItem className={ROW} onAction={() => setOption("signedIn", true)}>
              Sign in
            </MenuItem>
          </MenuSection>
        )}
      </Menu>
    </MenuTrigger>
  );
}

/** The content column every prototype page uses. */
export const pageClass = "mx-auto flex w-full max-w-3xl flex-col gap-5 px-gutter-safe pt-3 pb-16";

/** A prototype page: its bar, then its content in the app's gutter. */
export function ProtoPage({
  bar,
  children,
  className,
}: {
  bar: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <>
      {bar}
      <div
        className={cn(pageClass, className)}
      >
        {children}
      </div>
    </>
  );
}
