/**
 * React Aria Components Tabs, styled to match ui/tabs.tsx (default variant,
 * horizontal). RAC wires the ARIA tabs pattern — roving-tabindex arrow-key
 * navigation, automatic selection on focus, and panel association — and only
 * the selected TabPanel renders its content.
 *
 * Controlled usage mirrors the old value/onValueChange with RAC's
 * selectedKey/onSelectionChange; Tab and TabPanel pair up by `id`.
 */
import {
  Tabs as AriaTabs,
  TabList as AriaTabList,
  Tab as AriaTab,
  TabPanel as AriaTabPanel,
  type TabsProps,
  type TabListProps,
  type TabProps,
  type TabPanelProps,
} from "react-aria-components";

import { cn } from "@/react/lib/utils";

export function Tabs({
  className,
  ...props
}: Omit<TabsProps, "className"> & { className?: string }) {
  return <AriaTabs className={cn("flex flex-col gap-2", className)} {...props} />;
}

export function TabList<T extends object>({
  className,
  ...props
}: Omit<TabListProps<T>, "className"> & { className?: string }) {
  return (
    <AriaTabList
      className={cn(
        "inline-flex h-8 w-fit items-center justify-center rounded-lg bg-muted p-[3px] text-muted-foreground",
        className
      )}
      {...props}
    />
  );
}

export function Tab({
  className,
  ...props
}: Omit<TabProps, "className"> & { className?: string }) {
  return (
    <AriaTab
      className={cn(
        "relative inline-flex h-[calc(100%-1px)] flex-1 cursor-default items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all outline-none select-none",
        "data-hovered:text-foreground data-disabled:pointer-events-none data-disabled:opacity-50 dark:text-muted-foreground dark:data-hovered:text-foreground",
        "data-focus-visible:border-ring data-focus-visible:ring-3 data-focus-visible:ring-ring/50",
        "data-selected:bg-background data-selected:text-foreground data-selected:shadow-sm dark:data-selected:border-input dark:data-selected:bg-input/30 dark:data-selected:text-foreground",
        className
      )}
      {...props}
    />
  );
}

export function TabPanel({
  className,
  ...props
}: Omit<TabPanelProps, "className"> & { className?: string }) {
  return (
    <AriaTabPanel
      className={cn(
        "flex-1 text-sm outline-none data-focus-visible:ring-2 data-focus-visible:ring-ring/50",
        className as string
      )}
      {...props}
    />
  );
}
