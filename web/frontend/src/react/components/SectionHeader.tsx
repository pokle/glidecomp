/**
 * Standard section header row: the title owns the left edge (so scanning down
 * the page reads clean), and the section's manage action sits right-aligned
 * on the same row. This is the design-language pattern behind the Settings /
 * Edit route… / Pilots Edit / Submit track buttons — use it for any new
 * section that carries a section-scoped action. Inline CTA clusters (like the
 * comp hero's action row) are content, not section management: keep those
 * left-aligned and don't use this component for them.
 */
import { cn } from "@/react/lib/utils";

export function SectionHeader({
  title,
  action,
  className,
  as: Heading = "h2",
}: {
  title: React.ReactNode;
  /** Right-aligned action, typically a small outline Button. */
  action?: React.ReactNode;
  className?: string;
  /** Heading level — "h1" when the section IS the page (e.g. /comp/:id/pilots). */
  as?: "h1" | "h2";
}) {
  return (
    <div className={cn("mt-8 flex flex-wrap items-center gap-x-4 gap-y-2", className)}>
      <Heading
        className={cn(
          "min-w-0 flex-1 font-bold",
          Heading === "h1" ? "text-2xl" : "text-lg"
        )}
      >
        {title}
      </Heading>
      {action}
    </div>
  );
}
