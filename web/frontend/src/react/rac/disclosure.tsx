/**
 * React Aria Components Disclosure — collapsible sections with proper
 * button/region semantics. Used for the route editor's Start (SSS) and Goal
 * panels, which are collapsed by default (no `defaultExpanded`) — their
 * defaults suit most competitions, so collapsing them keeps the turnpoint list
 * the focus of the dialog. Pass `defaultExpanded` where a panel should open.
 */
import {
  Disclosure as AriaDisclosure,
  DisclosurePanel as AriaDisclosurePanel,
  Heading,
  Button as AriaButton,
  type DisclosureProps as AriaDisclosureProps,
} from "react-aria-components";

import { cn } from "@/react/lib/utils";
import { ChevronRightIcon } from "lucide-react";

export function Disclosure({
  title,
  badge,
  className,
  children,
  ...props
}: Omit<AriaDisclosureProps, "className" | "children"> & {
  title: React.ReactNode;
  /** Optional inline annotation next to the title (e.g. a summary). */
  badge?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <AriaDisclosure
      className={cn("group border-t border-border pt-3", className)}
      {...props}
    >
      <Heading className="flex items-center gap-2">
        <AriaButton
          slot="trigger"
          className="flex items-center gap-1.5 rounded text-sm font-medium outline-none data-hovered:text-foreground data-focus-visible:ring-2 data-focus-visible:ring-ring/50"
        >
          <ChevronRightIcon
            aria-hidden
            className="size-4 text-muted-foreground transition-transform group-data-expanded:rotate-90"
          />
          {title}
        </AriaButton>
        {badge}
      </Heading>
      {/* Print shows the panel even when collapsed — paper has no way to
          expand it, and a report that prints only its open drawers is not the
          report. RAC hides the collapsed panel with hidden="until-found"
          (content-visibility in supporting browsers, plain hidden elsewhere),
          so both properties need the override. */}
      <AriaDisclosurePanel className="pl-5.5 print:block! print:[content-visibility:visible]!">
        {children}
      </AriaDisclosurePanel>
    </AriaDisclosure>
  );
}
