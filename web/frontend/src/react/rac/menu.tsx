/**
 * React Aria Components Menu, styled to match ui/dropdown-menu.tsx. MenuItems
 * accept `href` (+ download/target) so "download in format X" entries are real
 * links with menu keyboard semantics.
 */
import {
  MenuTrigger,
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  Popover,
  type MenuProps as AriaMenuProps,
  type MenuItemProps,
} from "react-aria-components";

import { cn } from "@/react/lib/utils";
import { popoverClass } from "./select";

export function Menu<T extends object>({
  className,
  ...props
}: Omit<AriaMenuProps<T>, "className"> & { className?: string }) {
  return (
    <Popover className={cn(popoverClass, "min-w-44")}>
      <AriaMenu className={cn("outline-none", className)} {...props} />
    </Popover>
  );
}

export function MenuItem({
  className,
  ...props
}: Omit<MenuItemProps, "className"> & { className?: string }) {
  return (
    <AriaMenuItem
      className={cn(
        "flex w-full cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-none select-none",
        "data-focused:bg-accent data-focused:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
        className
      )}
      {...props}
    />
  );
}

export { MenuTrigger };
