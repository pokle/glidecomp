/**
 * Standard section header row: the title owns the left edge (so scanning down
 * the page reads clean), and the section's manage action sits right-aligned
 * on the same row. This is the design-language pattern behind the Settings /
 * Edit route / Pilots Edit / Submit track buttons — use it for any new
 * section that carries a section-scoped action. Inline CTA clusters (like the
 * comp hero's action row) are content, not section management: keep those
 * left-aligned and don't use this component for them.
 */
import { cn } from "@/react/lib/utils";

export function SectionHeader({
  title,
  action,
  className,
}: {
  title: React.ReactNode;
  /** Right-aligned action, typically a small outline Button. */
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    // No top margin of its own. Sections live inside `rac/card`'s Card now, and
    // the gap between cards is the stack's job — a component that reserves its
    // own external space fights whatever contains it.
    <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-2", className)}>
      {/* Always an h2: the page's h1 is its bar's title (rac/page-bar.tsx). */}
      <h2 className="min-w-0 flex-1 text-lg font-bold">{title}</h2>
      {action}
    </div>
  );
}
