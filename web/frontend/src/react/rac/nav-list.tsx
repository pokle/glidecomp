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
import { Link as AriaLink, Button as AriaButton } from "react-aria-components";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "@/react/lib/utils";
import { cardSurface, CardTitle } from "./card";

const rowClass =
  "flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left text-sm outline-none " +
  "data-hovered:bg-muted/50 data-pressed:bg-muted " +
  "data-focus-visible:ring-2 data-focus-visible:ring-ring/50 data-focus-visible:ring-inset";

export function NavList({
  label,
  children,
  className,
}: {
  /** Optional group heading rendered above the list surface. */
  label?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      {label ? <CardTitle className="mb-2">{label}</CardTitle> : null}
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
  description?: string;
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
        {description ? (
          <span className="text-muted-foreground">{description}</span>
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
  /** Secondary line under the label. */
  description?: string;
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
  icon,
  destructive,
  className,
}: {
  onPress: () => void;
  label: string;
  description?: string;
  icon?: React.ReactNode;
  destructive?: boolean;
  className?: string;
}) {
  return (
    <li>
      <AriaButton
        onPress={onPress}
        className={cn(
          rowClass,
          destructive && "font-medium text-destructive",
          className
        )}
      >
        <RowBody
          label={label}
          description={description}
          icon={icon}
          chevron={false}
        />
      </AriaButton>
    </li>
  );
}
