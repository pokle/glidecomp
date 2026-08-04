/**
 * Card — the app's one panel surface.
 *
 * A static styled element, which the kit explicitly allows when there is no
 * behaviour to own (see `rac/badge.tsx`, `rac/alert.tsx`). It exists because
 * there wasn't one: ~20 distinct hand-rolled surface strings had accumulated
 * across `src/react/` (`rounded-lg border p-4` eight times, the Settings page's
 * own local `SettingsCard`, and a long tail), so there was nowhere to fix
 * elevation or padding once.
 *
 * The surface is three signals, not one — `bg-card` over the tinted
 * `--background` ground, a `border`, and `shadow-card`. Before this, a card was
 * white-on-white plus a 10%-black hairline, which is why cards read as flat.
 *
 * `CardTitle` deliberately switches TYPE REGISTER rather than just size: small,
 * uppercase, tracked, mono, muted. A section heading is then a different KIND
 * of thing from body text and the eye segments the page without measuring 2px
 * of weight difference. Numbers get the same mono face (`font-mono
 * tabular-nums`) — scores, distances and climb rates are read in columns, and
 * the shared face is what ties the label row to the figures under it.
 */
import { cn } from "@/react/lib/utils";

export function Card({
  className,
  ...props
}: React.ComponentProps<"section">) {
  return (
    <section
      data-slot="card"
      className={cn(
        "flex flex-col gap-4 rounded-xl border bg-card p-5 text-sm text-card-foreground shadow-card",
        className
      )}
      {...props}
    />
  );
}

/**
 * Title row. `action` is the section-scoped slot the design language puts
 * right-aligned on the header row (same rule as `components/SectionHeader`).
 */
export function CardHeader({
  title,
  description,
  action,
  as: Heading = "h2",
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Right-aligned slot on the title row — a small button, a status flash. */
  action?: React.ReactNode;
  as?: "h2" | "h3";
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-start gap-x-4 gap-y-1", className)}>
      <div className="grid min-w-0 flex-1 gap-1.5">
        <CardTitle as={Heading}>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/**
 * The eyebrow register. 11px is small, so it carries weight (600) and 0.08em
 * of tracking to stay legible, and `--muted-foreground` clears 6.3:1 on a card
 * — uppercasing is done in CSS, so assistive tech still reads the real text.
 */
export function CardTitle({
  as: Heading = "h2",
  className,
  ...props
}: React.ComponentProps<"h2"> & { as?: "h2" | "h3" }) {
  return (
    <Heading
      data-slot="card-title"
      className={cn(
        "font-mono text-[11px] leading-none font-semibold tracking-[0.08em] text-muted-foreground uppercase",
        className
      )}
      {...props}
    />
  );
}

export function CardDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="card-description"
      className={cn("text-sm text-balance text-muted-foreground", className)}
      {...props}
    />
  );
}

/**
 * Intrinsic column grid: it fills to the container's real width rather than to
 * a viewport breakpoint. `sm:grid-cols-2 lg:grid-cols-3` measures the WINDOW,
 * so fields inside a narrow column go three-up on a wide screen whether or not
 * three fit; `auto-fit`/`minmax` measures the space that actually exists.
 *
 * `min` is the narrowest a column may be before the grid drops one.
 */
export function CardGrid({
  min = "13rem",
  className,
  style,
  ...props
}: React.ComponentProps<"div"> & { min?: string }) {
  return (
    <div
      data-slot="card-grid"
      className={cn("grid gap-4", className)}
      style={{
        gridTemplateColumns: `repeat(auto-fit, minmax(min(${min}, 100%), 1fr))`,
        ...style,
      }}
      {...props}
    />
  );
}
