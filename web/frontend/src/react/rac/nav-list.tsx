/**
 * NavList — a grouped list of tappable rows, the mobile-first way into a
 * hierarchy: each row names a destination (a settings group, a sub-page),
 * shows a muted summary of its current value, and navigates on press. The
 * pattern phones use for settings, adopted app-wide (one pattern everywhere,
 * desktop included) — see the comp settings pages.
 *
 * Built on RAC `Link`/`Button` so rows client-route through the
 * RouterProvider (rac/router.tsx) and carry the kit's hover/focus states.
 * Rows are a minimum 44px tall (WCAG 2.5.8 / mobile touch guideline) — the
 * whole row is the target, not just its label.
 *
 * `NavRow` navigates; `NavActionRow` is the same row shape for an action
 * (e.g. a destructive "Delete…" at the foot of an index). Focus rings are
 * inset because the list surface clips at its rounded corners.
 */
import { Link as AriaLink, Button as AriaButton, FileTrigger } from "react-aria-components";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "@/react/lib/utils";
import { cardSurface, CardTitle } from "./card";
import { Spinner } from "./progress";

/**
 * The row treatment itself, exported so a list that ISN'T a NavList can still
 * look like one — the route editor's turnpoint list is a RAC GridList (it
 * needs a collection, and rows that hold buttons), but a reader should not be
 * able to tell it apart from the settings rows it sits beside.
 */
// `text-base`: these rows are the iOS grouped-list pattern, and the pattern's
// label is Body. At `text-sm` the app's most native-feeling surface was still
// setting its row labels at Footnote size (issue #704).
export const navRowClass =
  "flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left text-base outline-none " +
  "data-hovered:bg-muted/50 data-pressed:bg-muted " +
  "data-focus-visible:ring-2 data-focus-visible:ring-ring/50 data-focus-visible:ring-inset";

const rowClass = navRowClass;

export function NavList({
  label,
  labelAs,
  children,
  className,
}: {
  /** Optional group heading rendered above the list surface. */
  label?: string;
  /**
   * The heading's level. `h3` where the lists are groups UNDER a section that
   * already has an `h2` (the comp page's Tasks, one list per flying day).
   */
  labelAs?: "h2" | "h3";
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      {label ? (
        <CardTitle as={labelAs} className="mb-2">
          {label}
        </CardTitle>
      ) : null}
      <ul className={cn(cardSurface, "divide-y divide-border overflow-hidden")}>
        {children}
      </ul>
    </div>
  );
}

function RowBody({
  label,
  value,
  description,
  icon,
  chevron = true,
}: {
  label: string;
  value?: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  chevron?: boolean;
}) {
  return (
    <>
      {icon ? (
        <span aria-hidden className="shrink-0 text-muted-foreground">
          {icon}
        </span>
      ) : null}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium">{label}</span>
        {/* A step down from the label, the way a subtitle is on iOS. The
            right-hand `value` stays at the row's own size and separates by
            colour alone — also the platform's habit, and what the comp
            settings list already looked like. */}
        {description ? (
          <span className="text-sm text-muted-foreground">{description}</span>
        ) : null}
      </span>
      {value != null ? (
        <span className="min-w-0 max-w-[45%] truncate text-muted-foreground">
          {value}
        </span>
      ) : null}
      {chevron ? (
        <ChevronRightIcon
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground"
        />
      ) : null}
    </>
  );
}

export function NavRow({
  to,
  label,
  value,
  description,
  icon,
  className,
}: {
  to: string;
  label: string;
  /** Current-value summary, right-aligned, muted, truncated. */
  value?: React.ReactNode;
  /**
   * Secondary line under the label. A node, so a row can carry a status
   * badge beside its facts (the comp page's task rows).
   */
  description?: React.ReactNode;
  /** Left of the label: an icon, or a small figure that identifies the row. */
  icon?: React.ReactNode;
  className?: string;
}) {
  return (
    <li>
      <AriaLink href={to} className={cn(rowClass, className)}>
        <RowBody
          label={label}
          value={value}
          description={description}
          icon={icon}
        />
      </AriaLink>
    </li>
  );
}

export function NavActionRow({
  onPress,
  label,
  description,
  value,
  icon,
  destructive,
  isPending,
  isDisabled,
  pendingLabel = "In progress",
  className,
}: {
  /** Unavailable for now, as while another of the page's actions runs. */
  isDisabled?: boolean;
  onPress: () => void;
  label: string;
  description?: string;
  /** Right-aligned muted summary, as on a NavRow. */
  value?: React.ReactNode;
  icon?: React.ReactNode;
  destructive?: boolean;
  /**
   * The action is in flight (`useAction().pending`): the row says so and
   * takes no second press, and stays focusable — the kit Button's rule.
   */
  isPending?: boolean;
  /** Accessible name for the pending spinner. */
  pendingLabel?: string;
  className?: string;
}) {
  return (
    <li>
      <AriaButton
        onPress={onPress}
        isPending={isPending}
        isDisabled={isDisabled}
        className={cn(
          rowClass,
          destructive && "font-medium text-danger",
          "data-pending:cursor-default data-pending:opacity-70 data-disabled:opacity-50",
          className
        )}
      >
        <RowBody
          label={label}
          description={description}
          icon={icon}
          value={isPending ? <Spinner label={pendingLabel} /> : value}
          chevron={false}
        />
      </AriaButton>
    </li>
  );
}

/**
 * A row that asks for a file: pressing it opens the system's file picker.
 * It is {@link NavActionRow} for an action whose first step is a file (an
 * upload), so it sits in a list of a page's actions as one of them.
 */
export function NavFileRow({
  onSelect,
  acceptedFileTypes,
  label,
  description,
  isPending,
  isDisabled,
  pendingLabel = "In progress",
}: {
  onSelect: (files: FileList | null) => void;
  /** As the kit's FileTrigger takes them: [".igc"]. */
  acceptedFileTypes?: string[];
  label: string;
  description?: string;
  isPending?: boolean;
  isDisabled?: boolean;
  pendingLabel?: string;
}) {
  return (
    <li>
      <FileTrigger acceptedFileTypes={acceptedFileTypes} onSelect={onSelect}>
        <AriaButton
          isPending={isPending}
          isDisabled={isDisabled}
          className={cn(
            rowClass,
            "data-pending:cursor-default data-pending:opacity-70 data-disabled:opacity-50"
          )}
        >
          <RowBody
            label={label}
            description={description}
            value={isPending ? <Spinner label={pendingLabel} /> : undefined}
            chevron={false}
          />
        </AriaButton>
      </FileTrigger>
    </li>
  );
}
